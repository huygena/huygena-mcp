import { formatBrief, formatSearch, intake, search, type SearchSort } from "huygena-intake";
import {
  compare,
  hashBundle,
  lintManifest,
  manifestHash,
  normalizeSha256,
  parseBundle,
  parseDocument,
  NodeResultsSchema,
  verifyBundle,
  verifyCertificate,
  type Bundle,
  type CompareReport,
  type Finding,
  type NodeResults,
} from "huygena-verify";

import type { Deps } from "./deps.js";
import { draftManifest } from "./draft.js";
import { dirInRoot, docText, ToolError } from "./files.js";

/** What every tool returns: a short text for people and models, and the full data. */
export type Output = { summary: string; data: Record<string, unknown> };

const MAX_LISTED = 25;

function intakeOpts(deps: Deps, signal?: AbortSignal) {
  return { fetch: deps.fetch, githubToken: deps.githubToken, mailto: deps.mailto, signal };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function listed<T>(items: T[], line: (x: T) => string): string[] {
  const out = items.slice(0, MAX_LISTED).map(line);
  if (items.length > MAX_LISTED) out.push(`  … ${items.length - MAX_LISTED} more in the JSON`);
  return out;
}

// ---------- paper_intake ----------

export async function paperIntake(deps: Deps, a: { input: string; full_text?: boolean; check_github?: boolean }, signal?: AbortSignal): Promise<Output> {
  const brief = await intake(a.input, { ...intakeOpts(deps, signal), fullText: a.full_text ?? true, checkGithub: a.check_github ?? true });
  return { summary: formatBrief(brief, { color: false, width: 100 }), data: brief as unknown as Record<string, unknown> };
}

// ---------- literature_search ----------

export async function literatureSearch(
  deps: Deps,
  a: { query: string; limit?: number; sort?: SearchSort; timeout_seconds?: number },
  signal?: AbortSignal,
): Promise<Output> {
  const timeoutMs = (a.timeout_seconds ?? 60) * 1000;
  const result = await search(a.query, { ...intakeOpts(deps, signal), limit: a.limit ?? 10, sort: a.sort ?? "relevance", timeoutMs });
  return { summary: formatSearch(result, { color: false, width: 100 }), data: result as unknown as Record<string, unknown> };
}

// ---------- validate_manifest ----------

function findingLines(findings: Finding[]): string[] {
  return listed(findings, (f) => `  ${f.severity.padEnd(7)} ${(f.path || "(document)").padEnd(22)} ${f.code}: ${f.message}`);
}

export async function validateManifest(deps: Deps, a: { manifest: string }): Promise<Output> {
  const { text, file } = await docText(deps.root, a.manifest);
  const report = lintManifest(text);
  let hash: string | null = null;
  try {
    hash = await manifestHash(text);
  } catch {
    // Unparseable: the syntax finding says why.
  }
  const m = report.manifest;
  const verdict = report.ok
    ? `PASS  manifest is valid${report.warnings ? `, with ${plural(report.warnings, "warning")}` : ""}`
    : `FAIL  ${plural(report.errors, "error")}: fix them before this manifest is run`;
  const lines = [verdict];
  if (file) lines.push(`file  ${file}`);
  if (hash) lines.push(`hash  ${hash}`);
  if (m) lines.push(`paper ${m.paper} · ${plural(m.claims.length, "claim")} · run ${m.run.where}, confirm ${m.run.confirm}`);
  if (report.findings.length) lines.push("", ...findingLines(report.findings));
  if (hash) lines.push("", "The hash is what a certificate anchors. Any change to a value changes it; comments, key order and YAML vs JSON do not.");
  return {
    summary: lines.join("\n"),
    data: { ok: report.ok, errors: report.errors, warnings: report.warnings, infos: report.infos, manifest_hash: hash, findings: report.findings, manifest: m },
  };
}

// ---------- hash_bundle ----------

export async function bundleHash(deps: Deps, a: { path: string; ignore?: string[] }): Promise<Output> {
  const dir = await dirInRoot(deps.root, a.path);
  const skipped: { path: string; reason: string }[] = [];
  const bundle = await hashBundle(dir.abs, { ignore: a.ignore, onSkip: (path, reason) => skipped.push({ path, reason }) });
  const bytes = bundle.files.reduce((n, f) => n + f.size, 0);
  const lines = [`root  ${bundle.root}`, `${plural(bundle.files.length, "file")}, ${bytes.toLocaleString("en-US")} bytes, folder ${dir.rel}`];
  if (bundle.ignore?.length) lines.push(`ignore ${bundle.ignore.join(", ")}`);
  lines.push("", ...listed(bundle.files, (f) => `  ${f.sha256.slice(7, 19)}…  ${String(f.size).padStart(10)}  ${f.path}`));
  if (skipped.length) lines.push("", "Not in the bundle:", ...listed(skipped, (s) => `  ${s.path}: ${s.reason}`));
  lines.push("", "Save the JSON as bundle.json next to (not inside) the folder, or pass it to verify_bundle as expected.");
  return { summary: lines.join("\n"), data: { folder: dir.rel, bundle, skipped } };
}

// ---------- verify_bundle ----------

const ROOT_RE = /^(sha256:)?[0-9a-f]{64}$/i;

async function expectedBundle(deps: Deps, expected: string): Promise<Bundle | string> {
  const v = expected.trim();
  if (ROOT_RE.test(v)) {
    const root = normalizeSha256(v);
    if (!root) throw new ToolError("invalid_expected", "expected root is not a SHA-256");
    return root;
  }
  const { text } = await docText(deps.root, v);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ToolError("invalid_expected", "expected must be bundle.json content, a path to a bundle.json file, or a root hash (sha256:<64 hex>)");
  }
  try {
    return parseBundle(value);
  } catch (e) {
    throw new ToolError("invalid_expected", (e as Error).message);
  }
}

export async function bundleVerify(deps: Deps, a: { path: string; expected: string; ignore?: string[] }): Promise<Output> {
  const dir = await dirInRoot(deps.root, a.path);
  const expected = await expectedBundle(deps, a.expected);
  const diff = await verifyBundle(dir.abs, expected, { ignore: a.ignore });
  const lines = [diff.ok ? `MATCH  ${dir.rel} hashes to ${diff.actualRoot}` : `MISMATCH  ${dir.rel} hashes to ${diff.actualRoot}, expected ${diff.expectedRoot}`];
  if (diff.rootOnly && !diff.ok) lines.push("Only a root hash was given, so the changed files cannot be named. Pass the full bundle.json to see them.");
  if (!diff.expectedConsistent) lines.push("The expected bundle.json does not hash to its own root: its file list was edited by hand.");
  if (diff.modified.length) lines.push("", "modified:", ...listed(diff.modified, (m) => `  ${m.path}  ${m.expected.sha256.slice(7, 19)}… -> ${m.actual.sha256.slice(7, 19)}…`));
  if (diff.added.length) lines.push("", "added:", ...listed(diff.added, (f) => `  ${f.path}`));
  if (diff.missing.length) lines.push("", "missing:", ...listed(diff.missing, (f) => `  ${f.path}`));
  return { summary: lines.join("\n"), data: { folder: dir.rel, ...diff } };
}

// ---------- compare_claims ----------

async function readResults(deps: Deps, value: string, i: number): Promise<NodeResults> {
  const { text, file } = await docText(deps.root, value);
  const label = file ?? `results[${i}]`;
  let raw: unknown;
  try {
    raw = parseDocument(text);
  } catch (e) {
    throw new ToolError("invalid_results", `${label} is not valid JSON or YAML: ${(e as Error).message}`);
  }
  const r = NodeResultsSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new ToolError("invalid_results", `${label} is not a results.v0 document: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return r.data;
}

function compareSummary(report: CompareReport, hash: string, manifestMismatch: string[]): string {
  const s = report.summary;
  const counts = Object.entries(s.counts)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${v}`);
  if (s.mismatches) counts.push(plural(s.mismatches, "mismatch").replace("mismatchs", "mismatches"));
  const lines = [
    `${plural(s.total, "claim")} · nodes ${report.nodes.join(" + ")}${s.twoNodes ? "" : " (one node: verdicts are not confirmed)"} · rules ${report.rules.version}, partial factor ${report.rules.partialFactor}`,
    counts.join(" · "),
    `manifest ${hash}`,
    "",
  ];
  const w = Math.min(32, Math.max(...report.claims.map((c) => c.id.length)));
  for (const c of report.claims) {
    const verdict = c.mismatch ? "MISMATCH" : c.verdict ?? "-";
    const values = c.nodes.map((n) => `${n.node}=${n.value ?? "-"}`).join(" ");
    lines.push(`  ${c.id.padEnd(w)}  ${verdict.padEnd(20)}  reported ${c.reported ?? "-"}  ${values}`);
    lines.push(`  ${"".padEnd(w)}  ${c.reason}`);
  }
  const notes = [...manifestMismatch, ...report.notes];
  if (notes.length) lines.push("", "Notes:", ...notes.map((n) => `  ${n}`));
  lines.push("", "Failed means not reproduced with the published code and data. It never means fraud.");
  return lines.join("\n");
}

export async function compareClaims(deps: Deps, a: { manifest: string; results: string | string[]; partial_factor?: number }): Promise<Output> {
  const { text } = await docText(deps.root, a.manifest);
  const lint = lintManifest(text);
  if (!lint.manifest) {
    const f = lint.findings[0];
    throw new ToolError("invalid_manifest", `manifest does not match manifest.v0 (${f?.path || "(document)"}: ${f?.message}). Run validate_manifest for the full list.`);
  }
  if (!lint.ok) {
    const f = lint.findings.find((x) => x.severity === "error");
    throw new ToolError(
      "invalid_manifest",
      `manifest has ${plural(lint.errors, "lint error")} (first: ${f?.path || "(document)"}: ${f?.message}). Verdicts are only computed against a manifest that passes validate_manifest.`,
    );
  }
  const list = Array.isArray(a.results) ? a.results : [a.results];
  if (list.length < 1 || list.length > 2) throw new ToolError("invalid_results", `pass results from 1 or 2 nodes, got ${list.length}`);
  const results = await Promise.all(list.map((r, i) => readResults(deps, r, i)));
  const hash = await manifestHash(text);
  const manifestMismatch = results.filter((r) => r.manifest !== undefined && r.manifest !== hash).map((r) => `${r.node} ran manifest ${r.manifest}, not ${hash}`);
  const report = compare(lint.manifest, results, { partialFactor: a.partial_factor });
  return { summary: compareSummary(report, hash, manifestMismatch), data: { manifest_hash: hash, manifest_mismatch: manifestMismatch, ...report } };
}

// ---------- verify_certificate ----------

export async function certificateVerify(
  deps: Deps,
  a: { certificate: string; manifest?: string; bundle_path?: string; ignore?: string[] },
): Promise<Output> {
  const { text } = await docText(deps.root, a.certificate);
  let cert: unknown;
  try {
    cert = parseDocument(text);
  } catch (e) {
    throw new ToolError("invalid_certificate", `certificate is not valid JSON: ${(e as Error).message}`);
  }
  const manifest = a.manifest !== undefined ? (await docText(deps.root, a.manifest)).text : undefined;
  const bundleDir = a.bundle_path !== undefined ? (await dirInRoot(deps.root, a.bundle_path)).abs : undefined;
  const report = await verifyCertificate(cert, { manifest, bundleDir, ignore: a.ignore });
  const n = report.counts;
  const lines = [
    `${report.ok ? "OK    no check failed" : "FAIL  at least one check failed"} · ${n.pass} pass · ${n.fail} fail · ${n.skipped} skipped · ${n.planned} planned`,
    report.certificate ? `run ${report.certificate.run} · paper ${report.certificate.paper} · nodes ${report.certificate.nodes.primary} + ${report.certificate.nodes.confirming ?? "none"}` : "",
    "",
    ...report.checks.map((c) => `  ${c.status.padEnd(8)} ${c.id.padEnd(22)} ${c.detail}`),
    "",
    "planned = not implemented yet (TEE attestation signatures, on-chain lookup). Planned and skipped checks are not passes.",
  ].filter((l, i) => l !== "" || i > 1);
  return { summary: lines.join("\n"), data: report as unknown as Record<string, unknown> };
}

// ---------- draft_manifest ----------

export async function draft(deps: Deps, a: { input: string; resolve_commit?: boolean }, signal?: AbortSignal): Promise<Output> {
  const brief = await intake(a.input, { ...intakeOpts(deps, signal), checkGithub: true });
  const d = await draftManifest(deps, brief, { resolveCommit: a.resolve_commit ?? true, signal });
  const pin = d.code.commit ? `${d.code.repo}@${d.code.commit} (${d.code.commitSource?.replace(/_/g, " ")})` : d.code.repo ? `${d.code.repo}, commit not pinned` : "no code link";
  const lines = [
    `Draft manifest for: ${d.paper.title}`,
    `paper ${d.paper.id ?? "(no DOI or arXiv id)"} · readiness ${d.readiness.level.toUpperCase()} · code ${pin} · ${d.data.included} of ${d.data.total} data links`,
    `lint: ${plural(d.lint.errors, "error")}, ${plural(d.lint.warnings, "warning")}. Errors are the parts a person must fill in; the draft is not runnable until lint passes.`,
    "",
    d.manifestYaml.trimEnd(),
    "",
    "To do:",
    ...d.todo.map((t) => `  - ${t}`),
  ];
  if (d.warnings.length) lines.push("", "Warnings:", ...d.warnings.map((w) => `  - ${w}`));
  lines.push("", "When the placeholders are filled in, run validate_manifest on the result.");
  return { summary: lines.join("\n"), data: d as unknown as Record<string, unknown> };
}
