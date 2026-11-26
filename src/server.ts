import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { IntakeError } from "huygena-intake";
import { BundlePathError, CompareError, DocumentParseError, jsonSchemas } from "huygena-verify";
import { z } from "zod";

import { SERVER_NAME, SERVER_VERSION, type Deps } from "./deps.js";
import { ToolError } from "./files.js";
import { bundleHash, bundleVerify, certificateVerify, compareClaims, draft, literatureSearch, paperIntake, validateManifest, type Output } from "./tools.js";

export { SERVER_NAME, SERVER_VERSION };

const INSTRUCTIONS = `Huygena tools for replicating computational papers.
Typical flow: paper_intake (is this paper re-runnable?) -> draft_manifest (manifest skeleton) -> the user fills in claims, container digest and data hashes -> validate_manifest until it passes.
After a re-run: compare_claims (verdicts from one or two nodes' results), hash_bundle / verify_bundle (evidence folder), verify_certificate (re-check a certificate).
Verdicts: Replicated, Partially replicated, Failed, Could not run. Failed means not reproduced with the published code and data, never fraud.
Not live yet: Huygena contracts, bounties, GPU TEE runs and on-chain certificates. No tool here starts a run or spends money.
File tools only read inside the server's root folder (HUYGENA_MCP_ROOT); paths are relative to it.`;

/** Text for people and older clients, JSON for code. The JSON is also sent as text, as the MCP spec recommends. */
function ok(out: Output): CallToolResult {
  return {
    content: [
      { type: "text", text: out.summary },
      { type: "text", text: JSON.stringify(out.data) },
    ],
    structuredContent: out.data,
  };
}

function errorCode(e: unknown): string {
  if (e instanceof ToolError || e instanceof IntakeError) return e.code;
  if (e instanceof CompareError) return "compare_failed";
  if (e instanceof DocumentParseError) return "parse_error";
  if (e instanceof BundlePathError) return "invalid_bundle_path";
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "error";
}

/** Errors come back as tool results the model can read and act on, never as crashes or protocol errors. */
async function run(deps: Deps, name: string, fn: () => Promise<Output>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    const code = errorCode(e);
    const message = e instanceof Error ? e.message : String(e);
    deps.log(`${name} failed (${code}): ${message}`);
    return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
  }
}

const DOC = (what: string) =>
  `${what}, as inline text, or a path to a .yaml/.yml/.json file under the server root (one line, no leading { or [).`;
const IGNORE = z
  .array(z.string().min(1).max(200))
  .max(50)
  .optional()
  .describe("Extra gitignore-style patterns to leave out, e.g. [\"*.tmp\", \"cache/\"]. .git is always ignored.");
const READ_LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const READ_WEB = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Where huygena-verify is installed, for SPEC.md. */
function verifyDir(): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve("huygena-verify/package.json"));
  } catch {
    return null;
  }
}

function readSpec(): string | null {
  const dir = verifyDir();
  if (!dir) return null;
  try {
    return readFileSync(join(dir, "SPEC.md"), "utf8");
  } catch {
    return null;
  }
}

/** SPEC.md sections 3 and 4: tolerance and verdict rules. */
export function verdictRules(spec: string | null): string {
  if (spec) {
    const start = spec.indexOf("## 3. Tolerance rules");
    const end = spec.indexOf("## 5.", start);
    if (start >= 0 && end > start) {
      return `# Huygena tolerance and verdict rules (draft v0)\n\nFrom huygena-verify SPEC.md. Implemented by the compare_claims tool.\n\n${spec.slice(start, end).trim()}\n`;
    }
  }
  return "SPEC.md was not found in the installed huygena-verify package. Read it at https://github.com/huygena/huygena-verify/blob/main/SPEC.md\n";
}

/** A fresh McpServer with every Huygena tool and resource. Transport wiring is in index.ts so tests can use an in-memory pair. */
export function createServer(deps: Deps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "paper_intake",
    {
      title: "Paper to replication brief",
      description:
        "Turns a paper ID or link into a replication brief: metadata, open-access status and license, the paper's own code links (checked on GitHub: live, moved, license, default branch), tools it merely mentions, data links and accessions, the raw code/data availability statements, and a rule-based readiness verdict (ready / partial / not_ready) with a reason per check. Uses Crossref, arXiv, bioRxiv, NCBI PMC, Europe PMC and GitHub; no API keys. Usually 1-5 s, up to ~20 s when Europe PMC is slow.",
      inputSchema: {
        input: z
          .string()
          .min(1)
          .max(500)
          .describe("DOI (10.1038/s41586-021-03819-2, doi.org URL, publisher URL), arXiv id or URL (2106.09685, arXiv:1706.03762v5), bioRxiv/medRxiv DOI or URL, PMID (PMID:34265844) or PMCID (PMC8371605)."),
        full_text: z.boolean().optional().describe("Read open full text from NCBI PMC / Europe PMC for availability statements and links. Default true. Set false for a faster, shallower brief."),
        check_repos: z.boolean().optional().describe("Check the paper's own code links on any host (git protocol, no token). Default true."),
        check_github: z.boolean().optional().describe("Deprecated alias of check_repos."),
      },
      annotations: { title: "Paper to replication brief", ...READ_WEB },
    },
    async (args, extra) => run(deps, "paper_intake", () => paperIntake(deps, args, extra.signal)),
  );

  server.registerTool(
    "literature_search",
    {
      title: "Search the literature",
      description:
        "Searches Europe PMC (PubMed, PMC, bioRxiv, medRxiv, arXiv and more) and returns ranked hits with DOI, PMID/PMCID, year, journal, open-access flag and citation count. Feed a hit's DOI or PMCID to paper_intake. Europe PMC can take 15-30 s on broad queries.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .max(1000)
          .describe('Europe PMC query. Plain words, or fields: TITLE:"protein structure" AND OPEN_ACCESS:y, AUTH:"Jumper J", PUB_YEAR:[2020 TO 2024].'),
        limit: z.number().int().min(1).max(100).optional().describe("Number of hits, 1-100. Default 10."),
        sort: z.enum(["relevance", "cited", "date"]).optional().describe("relevance (default), cited (most cited first) or date (newest first)."),
        timeout_seconds: z.number().int().min(5).max(120).optional().describe("Give up after this many seconds. Default 60."),
      },
      annotations: { title: "Search the literature", ...READ_WEB },
    },
    async (args, extra) => run(deps, "literature_search", () => literatureSearch(deps, args, extra.signal)),
  );

  server.registerTool(
    "draft_manifest",
    {
      title: "Draft a run manifest for a paper",
      description:
        "Runs paper_intake on a paper and writes a manifest.v0 skeleton (YAML) for re-running it: paper id, title, the paper's own repository pinned to a full commit SHA when one can be known (a commit in the paper's link, the tag/branch it links, or the default branch head from GitHub, labeled as such), the data links it found, and run settings. Claims, container digest, data hashes and seeds are left as <placeholders>: they must come from a person reading the paper, never from a guess. Returns the YAML, the lint report of the draft, a to-do list, and the abstract to help pick claims.",
      inputSchema: {
        input: z.string().min(1).max(500).describe("Paper ID or link, same forms as paper_intake."),
        resolve_commit: z
          .boolean()
          .optional()
          .describe("Ask GitHub (one request) for the commit behind the linked ref or the default branch. Default true. When false or when it fails, env.code keeps a placeholder."),
      },
      annotations: { title: "Draft a run manifest for a paper", ...READ_WEB },
    },
    async (args, extra) => run(deps, "draft_manifest", () => draft(deps, args, extra.signal)),
  );

  server.registerTool(
    "validate_manifest",
    {
      title: "Validate a run manifest",
      description:
        "Checks a Huygena run manifest (spec manifest.v0) against the schema and the lint rules: container pinned by digest, code pinned to a full commit, every claim with a reported value and a tolerance written before the run, seeds, data hashes, unfilled <placeholders>, tolerance bands that reach the value of no effect, unknown fields. Returns findings with severity, rule id and path, and the manifest hash a certificate anchors. Offline.",
      inputSchema: {
        manifest: z.string().min(1).max(5_000_000).describe(DOC("The manifest (YAML or JSON)")),
      },
      annotations: { title: "Validate a run manifest", ...READ_LOCAL },
    },
    async (args) => run(deps, "validate_manifest", () => validateManifest(deps, args)),
  );

  server.registerTool(
    "compare_claims",
    {
      title: "Compute claim verdicts",
      description:
        "Recomputes per-claim verdicts from re-run values and the tolerances in the manifest: Replicated, Partially replicated, Failed or Could not run, with the delta and the reason. Pass one node's results, or two (primary and confirming): with two, a verdict is issued only when both nodes agree, otherwise the claim is a mismatch. Also flags results that ran a different manifest hash. The manifest must pass validate_manifest. Offline. Rules: resource huygena://rules/verdicts.",
      inputSchema: {
        manifest: z.string().min(1).max(5_000_000).describe(DOC("The run manifest (YAML or JSON)")),
        results: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(2)])
          .describe(
            'One node\'s results.v0 document, or a list of two (primary, confirming). Each is JSON like {"node":"node-a","claims":{"table_2.auroc":0.9104,"x":{"error":"why it could not run"}}}, inline or as a path to a .json file under the server root.',
          ),
        partial_factor: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Width of the default Partially replicated band as a multiple of the tolerance band, for claims without their own partial band. Default 3 (draft). 1 turns it off."),
      },
      annotations: { title: "Compute claim verdicts", ...READ_LOCAL },
    },
    async (args) => run(deps, "compare_claims", () => compareClaims(deps, args)),
  );

  server.registerTool(
    "hash_bundle",
    {
      title: "Hash an evidence folder",
      description:
        "Hashes every regular file in a folder into a content-addressed evidence bundle (bundle.v0): sorted paths, SHA-256 and size per file, and a root hash that equals `sha256sum` of the files piped into `sha256sum`, so anyone can recompute it with coreutils. Symlinks are not followed. Only folders under the server root (HUYGENA_MCP_ROOT) can be read.",
      inputSchema: {
        path: z.string().min(1).max(4096).describe("Folder to hash, relative to the server root (or absolute, if inside it)."),
        ignore: IGNORE,
      },
      annotations: { title: "Hash an evidence folder", ...READ_LOCAL },
    },
    async (args) => run(deps, "hash_bundle", () => bundleHash(deps, args)),
  );

  server.registerTool(
    "verify_bundle",
    {
      title: "Check an evidence folder",
      description:
        "Re-hashes a folder and compares it with an expected bundle: names every modified, added and missing file, and catches a bundle.json whose file list was edited so it no longer hashes to its own root. With only a root hash it can say match or no match, not which file changed. Only folders under the server root can be read.",
      inputSchema: {
        path: z.string().min(1).max(4096).describe("Folder to check, relative to the server root."),
        expected: z
          .string()
          .min(1)
          .max(20_000_000)
          .describe("The expected bundle: bundle.json content, a path to a bundle.json file under the server root, or a bare root hash (sha256:<64 hex>)."),
        ignore: IGNORE,
      },
      annotations: { title: "Check an evidence folder", ...READ_LOCAL },
    },
    async (args) => run(deps, "verify_bundle", () => bundleVerify(deps, args)),
  );

  server.registerTool(
    "verify_certificate",
    {
      title: "Re-check a replication certificate",
      description:
        "Re-checks a certificate.v0 without trusting whoever issued it: schema, independent confirming node, and, when given, the manifest hash, claim ids and reported values against the manifest, each verdict recomputed from the values, the evidence bundle root, the attestation report hash and the step outputs. TEE attestation signatures and the on-chain record are not implemented yet and come back as planned, never as passes. Offline.",
      inputSchema: {
        certificate: z.string().min(1).max(5_000_000).describe(DOC("The certificate JSON")),
        manifest: z.string().min(1).max(5_000_000).optional().describe(DOC("The run manifest the certificate names")),
        bundle_path: z.string().min(1).max(4096).optional().describe("Evidence folder to hash and compare with the certificate's bundle root, relative to the server root."),
        ignore: IGNORE,
      },
      annotations: { title: "Re-check a replication certificate", ...READ_LOCAL },
    },
    async (args) => run(deps, "verify_certificate", () => certificateVerify(deps, args)),
  );

  // ---------- resources ----------

  const schemas = jsonSchemas();
  for (const [file, schema] of Object.entries(schemas)) {
    const id = file.replace(/\.schema\.json$/, "");
    const uri = `huygena://schema/${id}`;
    server.registerResource(
      `schema-${id}`,
      uri,
      { title: String(schema.title ?? id), description: `JSON Schema (draft 2020-12) for ${id} documents, from huygena-verify.`, mimeType: "application/schema+json" },
      async () => ({ contents: [{ uri, mimeType: "application/schema+json", text: JSON.stringify(schema, null, 2) }] }),
    );
  }

  server.registerResource(
    "verdict-rules",
    "huygena://rules/verdicts",
    { title: "Tolerance and verdict rules (draft v0)", description: "How compare_claims turns re-run values into verdicts: tolerance bands, partial band, direction check, two-node agreement.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: verdictRules(readSpec()) }] }),
  );

  server.registerResource(
    "spec-v0",
    "huygena://spec/v0",
    { title: "huygena-verify SPEC v0 (draft)", description: "Full spec: run manifest, node results, tolerance and verdict rules, evidence bundle, certificate.", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: readSpec() ?? "SPEC.md was not found. Read it at https://github.com/huygena/huygena-verify/blob/main/SPEC.md\n" }],
    }),
  );

  return server;
}
