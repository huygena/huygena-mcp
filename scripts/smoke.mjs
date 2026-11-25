// Starts the built server over stdio like an MCP client would, lists tools and resources,
// calls paper_intake and draft_manifest on AlphaFold 2 against the live APIs, and runs
// validate_manifest, compare_claims, verify_bundle and verify_certificate on huygena-verify's examples/.
// Read-only. Usage: pnpm build && pnpm smoke   (set GITHUB_TOKEN to avoid GitHub's 60/hour limit)
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const verifyDir = dirname(createRequire(import.meta.url).resolve("huygena-verify/package.json"));
const verbose = process.argv.includes("--verbose");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  // The file tools may read huygena-verify's folder, nothing else.
  env: { ...process.env, HUYGENA_MCP_ROOT: verifyDir },
  stderr: "inherit",
});
const client = new Client({ name: "huygena-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const show = (label, r) => {
  const summary = r.content?.[0]?.text ?? "";
  console.log(`\n=== ${label}${r.isError ? " (tool error)" : ""}`);
  console.log(verbose ? summary : summary.split("\n").slice(0, 14).join("\n"));
};
const call = async (name, args) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  show(`${name} ${JSON.stringify(args).slice(0, 110)}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`, r);
  return r;
};
const fail = (msg) => {
  console.error(`\nSMOKE FAILED: ${msg}`);
  process.exitCode = 1;
};

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const { resources } = await client.listResources();
console.log("resources:", resources.map((r) => r.uri).join(", "));

const AF2 = "10.1038/s41586-021-03819-2";
const brief = await call("paper_intake", { input: AF2 });
const b = brief.structuredContent;
if (brief.isError || b?.readiness?.level !== "ready") fail(`paper_intake: expected readiness ready, got ${b?.readiness?.level ?? brief.content?.[0]?.text}`);
const repo = b?.code?.find((c) => c.role === "primary")?.github?.fullName;
if (repo !== "google-deepmind/alphafold") fail(`paper_intake: primary repo ${repo}`);

const draft = await call("draft_manifest", { input: AF2 });
const d = draft.structuredContent;
if (draft.isError || d?.paper?.id !== `doi:${AF2}`) fail("draft_manifest: wrong paper id");
console.log(`code pin: ${d?.code?.repo}@${d?.code?.commit ?? "(not pinned)"} · ${d?.code?.commitSource ?? d?.code?.note}`);

// Europe PMC can be slow; a timeout here is reported, not fatal.
const s = await call("literature_search", { query: 'TITLE:"protein structure prediction"', limit: 3, sort: "cited", timeout_seconds: 45 });
if (s.isError) console.log("(Europe PMC did not answer; reported as a tool error above, not counted as a smoke failure)");

const v = await call("validate_manifest", { manifest: "examples/manifest.yaml" });
if (!v.structuredContent?.ok) fail("validate_manifest: example should pass");

const cmp = await call("compare_claims", { manifest: "examples/manifest.yaml", results: ["examples/results.node-a.json", "examples/results.node-b.json"] });
const verdicts = cmp.structuredContent?.claims?.map((c) => (c.mismatch ? "mismatch" : c.verdict)).join(",");
if (verdicts !== "Replicated,Replicated,Partially replicated,Failed,mismatch,Could not run") fail(`compare_claims: ${verdicts}`);

const vb = await call("verify_bundle", { path: "examples/evidence", expected: "examples/bundle.json" });
if (!vb.structuredContent?.ok) fail("verify_bundle: example should match");

const cert = await call("verify_certificate", { certificate: "examples/certificate.json", manifest: "examples/manifest.yaml", bundle_path: "examples/evidence" });
if (!cert.structuredContent?.ok) fail("verify_certificate: example should have no failed check");

const escape = await call("hash_bundle", { path: ".." });
if (!escape.isError) fail("hash_bundle should refuse a path outside the root");

await client.close();
console.log(process.exitCode ? "\nsmoke FAILED" : "\nsmoke ok");
