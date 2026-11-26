import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { depsFromEnv } from "../src/deps.js";
import { looksLikePath } from "../src/files.js";
import { verdictRules } from "../src/server.js";
import { AF2, connect, data, EXAMPLES, example, fakeFetch, testDeps, text, timeoutError } from "./helpers.js";

const MANIFEST_HASH = "sha256:3183bd7cd87ba9fcafeed9723ab55255e3d07bcf4b76be55c1759c72d911fbce";
const BUNDLE_ROOT = "sha256:f4f9b720e599b451270cf55acf8ce794854e86878e7841d674d047a8a2d8dc4d";

const TOOLS = ["compare_claims", "draft_manifest", "hash_bundle", "literature_search", "paper_intake", "validate_manifest", "verify_bundle", "verify_certificate"];

describe("server surface", () => {
  it("lists the eight tools, each with a description and described parameters", async () => {
    const { client } = await connect(testDeps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(80);
      expect(t.annotations?.readOnlyHint).toBe(true);
      const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [name, p] of Object.entries(props)) expect(p.description, `${t.name}.${name}`).toBeTruthy();
    }
  });

  it("does not offer a tool that would pretend to start a run or post a bounty", async () => {
    const { client } = await connect(testDeps());
    const names = (await client.listTools()).tools.map((t) => t.name).join(" ");
    expect(names).not.toMatch(/replicat|bounty|run_|pay/);
    expect(client.getInstructions()).toMatch(/Not live yet/);
  });

  it("serves the four JSON schemas and the verdict rules as resources", async () => {
    const { client } = await connect(testDeps());
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "huygena://rules/verdicts",
      "huygena://schema/bundle.v0",
      "huygena://schema/certificate.v0",
      "huygena://schema/manifest.v0",
      "huygena://schema/results.v0",
      "huygena://spec/v0",
    ]);
    const schema = await client.readResource({ uri: "huygena://schema/manifest.v0" });
    const s = JSON.parse((schema.contents[0] as { text: string }).text);
    expect(s.$id).toBe("https://raw.githubusercontent.com/huygena/huygena-verify/main/schema/manifest.v0.schema.json");
    expect(s.required).toEqual(expect.arrayContaining(["paper", "claims", "env", "run"]));
    const rules = (await client.readResource({ uri: "huygena://rules/verdicts" })).contents[0] as { text: string };
    expect(rules.text).toMatch(/## 3\. Tolerance rules/);
    expect(rules.text).toMatch(/Partially replicated/);
    expect(rules.text).not.toMatch(/## 5\. Evidence bundle/);
  });

  it("explains where to read the rules when SPEC.md is missing", () => {
    expect(verdictRules(null)).toMatch(/github\.com\/huygena\/huygena-verify/);
  });
});

describe("paper_intake", () => {
  it("returns the brief as structured content, a text summary and the JSON", async () => {
    const f = fakeFetch(AF2);
    const { call } = await connect(testDeps({ fetch: f.fetch }));
    const r = await call("paper_intake", { input: "10.1038/s41586-021-03819-2" });
    expect(r.isError).toBeFalsy();
    const b = data(r);
    expect(b).toMatchObject({ schema: "huygena.brief/v1", paper: { title: "Highly accurate protein structure prediction with AlphaFold" }, readiness: { level: "ready" } });
    expect(b.code.filter((c: { role: string }) => c.role === "primary")[0].repo.fullName).toBe("google-deepmind/alphafold");
    expect(text(r)).toMatch(/Readiness {2}READY/);
    expect(JSON.parse(text(r, 1))).toEqual(b);
    expect(f.unrouted.filter((u) => !/raw\.githubusercontent/.test(u))).toEqual([]);
  });

  it("passes full_text and check_github through", async () => {
    const f = fakeFetch(AF2);
    const { call } = await connect(testDeps({ fetch: f.fetch }));
    const r = await call("paper_intake", { input: "PMID:34265844", full_text: false, check_github: false });
    expect(data(r).access.fullText).toBeNull();
    expect(f.calls.some((c) => /github\.com|efetch/.test(c.url))).toBe(false);
  });

  it("never sends a token or Authorization header anywhere", async () => {
    const f = fakeFetch(AF2);
    const { call } = await connect(testDeps({ fetch: f.fetch }));
    await call("paper_intake", { input: "10.1038/s41586-021-03819-2" });
    for (const c of f.calls) expect(c.headers.Authorization ?? c.headers.authorization).toBeUndefined();
  });

  it("turns an unknown id into a tool error, not a crash", async () => {
    const { call } = await connect(testDeps({ fetch: fakeFetch([]).fetch }));
    const r = await call("paper_intake", { input: "not a paper" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid_id: /);
    // The server keeps answering afterwards.
    const again = await call("validate_manifest", { manifest: "examples/manifest.yaml" });
    expect(again.isError).toBeFalsy();
  });
});

describe("literature_search", () => {
  it("maps Europe PMC hits and forwards limit and sort", async () => {
    const f = fakeFetch([{ match: /europepmc/, file: "epmc-search.json" }]);
    const { call } = await connect(testDeps({ fetch: f.fetch }));
    const r = await call("literature_search", { query: "protein structure prediction", limit: 5, sort: "cited" });
    expect(r.isError).toBeFalsy();
    expect(data(r).hits).toHaveLength(5);
    expect(f.calls[0]!.url).toContain("pageSize=5");
    expect(f.calls[0]!.url).toContain("sort=CITED%20desc");
    expect(text(r)).toMatch(/^Europe PMC/);
  });

  it("reports a timeout as a tool error", async () => {
    const { call } = await connect(testDeps({ fetch: fakeFetch([{ match: /europepmc/, error: timeoutError() }]).fetch }));
    const r = await call("literature_search", { query: "protein", timeout_seconds: 5 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^timeout: /);
  });

  it("rejects bad arguments with a readable message", async () => {
    const { call } = await connect(testDeps());
    const r = await call("literature_search", { query: "x", limit: 1000 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/limit|query/);
  });
});

describe("validate_manifest", () => {
  it("passes the example manifest by path and returns its hash", async () => {
    const { call } = await connect(testDeps());
    const r = await call("validate_manifest", { manifest: "examples/manifest.yaml" });
    expect(data(r)).toMatchObject({ ok: true, errors: 0, manifest_hash: MANIFEST_HASH });
    expect(text(r)).toMatch(/^PASS/);
  });

  it("gives the same hash for the same manifest as inline JSON", async () => {
    const { call } = await connect(testDeps());
    const asJson = JSON.stringify(data(await call("validate_manifest", { manifest: example("manifest.yaml") })).manifest);
    const r = await call("validate_manifest", { manifest: asJson });
    expect(data(r).manifest_hash).toBe(MANIFEST_HASH);
  });

  it("names the rule, path and message for each problem", async () => {
    const { call } = await connect(testDeps());
    const bad = example("manifest.yaml")
      .replace(/container: .*/, 'container: "ghcr.io/huygena/example-replication:latest"')
      .replace(/@363f38da5807127e85f8885bc0172d9cf35b032c/, "@main");
    const r = await call("validate_manifest", { manifest: bad });
    expect(data(r).ok).toBe(false);
    const codes = data(r).findings.map((f: { code: string; path: string }) => `${f.code}@${f.path}`);
    expect(codes).toEqual(expect.arrayContaining(["container-not-pinned@env.container", "code-not-pinned@env.code"]));
    expect(text(r)).toMatch(/^FAIL {2}2 errors/);
  });

  it("reports a syntax error as a finding with no hash", async () => {
    const { call } = await connect(testDeps());
    const r = await call("validate_manifest", { manifest: "paper: [unclosed\nclaims: {" });
    expect(r.isError).toBeFalsy();
    expect(data(r)).toMatchObject({ ok: false, manifest_hash: null });
    expect(data(r).findings[0].code).toBe("syntax");
  });
});

describe("compare_claims", () => {
  it("issues verdicts only where two nodes agree", async () => {
    const { call } = await connect(testDeps());
    const r = await call("compare_claims", { manifest: "examples/manifest.yaml", results: ["examples/results.node-a.json", "examples/results.node-b.json"] });
    expect(r.isError).toBeFalsy();
    const verdicts = Object.fromEntries(data(r).claims.map((c: { id: string; verdict: string | null; mismatch: boolean }) => [c.id, c.mismatch ? "mismatch" : c.verdict]));
    expect(verdicts).toEqual({
      "table_2.auroc": "Replicated",
      "table_2.auprc": "Replicated",
      "figure_3b.slope": "Partially replicated",
      "table_3.hazard_ratio": "Failed",
      "table_4.ece": "mismatch",
      "supp_table_2.external_auroc": "Could not run",
    });
    expect(data(r)).toMatchObject({ manifest_hash: MANIFEST_HASH, manifest_mismatch: [], summary: { twoNodes: true, mismatches: 1 } });
    expect(text(r)).toMatch(/table_3\.hazard_ratio +Failed/);
    expect(text(r)).toMatch(/never means fraud/);
  });

  it("marks a single node's verdicts as not confirmed", async () => {
    const { call } = await connect(testDeps());
    const r = await call("compare_claims", { manifest: example("manifest.yaml"), results: example("results.node-a.json") });
    expect(data(r).summary.twoNodes).toBe(false);
    expect(data(r).claims.every((c: { confirmed: boolean }) => !c.confirmed)).toBe(true);
  });

  it("flags results that ran a different manifest", async () => {
    const { call } = await connect(testDeps());
    const other = JSON.stringify({ ...JSON.parse(example("results.node-a.json")), manifest: `sha256:${"0".repeat(64)}` });
    const r = await call("compare_claims", { manifest: "examples/manifest.yaml", results: [other] });
    expect(data(r).manifest_mismatch[0]).toMatch(/^node-a ran manifest sha256:0{64}/);
  });

  it("applies partial_factor", async () => {
    const { call } = await connect(testDeps());
    const r = await call("compare_claims", { manifest: "examples/manifest.yaml", results: "examples/results.node-a.json", partial_factor: 1 });
    const slope = data(r).claims.find((c: { id: string }) => c.id === "figure_3b.slope");
    expect(slope.verdict).toBe("Failed");
    expect(data(r).rules.partialFactor).toBe(1);
  });

  it("refuses a manifest that does not pass lint, and bad results", async () => {
    const { call } = await connect(testDeps());
    const noTol = example("manifest.yaml").replace("    tolerance: 0.005\n", "");
    const r1 = await call("compare_claims", { manifest: noTol, results: "examples/results.node-a.json" });
    expect(r1.isError).toBe(true);
    expect(text(r1)).toMatch(/^invalid_manifest: .*claims\[0\]\.tolerance/);
    const r2 = await call("compare_claims", { manifest: "examples/manifest.yaml", results: '{"claims": {}}' });
    expect(text(r2)).toMatch(/^invalid_results: results\[0\] is not a results\.v0 document: node/);
    const a = example("results.node-a.json");
    const r3 = await call("compare_claims", { manifest: "examples/manifest.yaml", results: [a, a] });
    expect(text(r3)).toMatch(/^compare_failed: .*independent node/);
  });
});

describe("verify_certificate", () => {
  it("re-checks the example certificate with manifest and evidence folder", async () => {
    const { call } = await connect(testDeps());
    const r = await call("verify_certificate", { certificate: "examples/certificate.json", manifest: "examples/manifest.yaml", bundle_path: "examples/evidence" });
    expect(r.isError).toBeFalsy();
    const rep = data(r);
    expect(rep.ok).toBe(true);
    const status = Object.fromEntries(rep.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
    expect(status).toMatchObject({ "manifest-hash": "pass", verdicts: "pass", "bundle-root": "pass", "attestation-signature": "planned", "onchain-record": "planned" });
    expect(text(r)).toMatch(/planned = not implemented yet/);
  });

  it("fails a certificate whose verdict does not follow from the values", async () => {
    const { call } = await connect(testDeps());
    const cert = JSON.parse(example("certificate.json"));
    cert.claims[3].verdict = "Replicated";
    const r = await call("verify_certificate", { certificate: JSON.stringify(cert), manifest: "examples/manifest.yaml" });
    expect(data(r).ok).toBe(false);
    expect(data(r).checks.find((c: { id: string }) => c.id === "verdicts").status).toBe("fail");
  });

  it("skips what it was not given", async () => {
    const { call } = await connect(testDeps());
    const r = await call("verify_certificate", { certificate: "examples/certificate.json" });
    expect(data(r).counts.skipped).toBeGreaterThanOrEqual(6);
  });
});

describe("hash_bundle and verify_bundle", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "huygena-mcp-")));
    cpSync(join(EXAMPLES, "evidence"), join(tmp, "evidence"), { recursive: true });
    cpSync(join(EXAMPLES, "bundle.json"), join(tmp, "bundle.json"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("hashes the example evidence folder to the documented root", async () => {
    const { call } = await connect(testDeps());
    const r = await call("hash_bundle", { path: "examples/evidence" });
    expect(data(r).bundle.root).toBe(BUNDLE_ROOT);
    expect(data(r).bundle.files).toHaveLength(5);
    expect(text(r)).toMatch(new RegExp(`^root {2}${BUNDLE_ROOT}`));
  });

  it("matches against bundle.json by path, inline, or a bare root", async () => {
    const { call } = await connect(testDeps());
    for (const expected of ["examples/bundle.json", example("bundle.json"), BUNDLE_ROOT, BUNDLE_ROOT.slice(7)]) {
      const r = await call("verify_bundle", { path: "examples/evidence", expected });
      expect(data(r).ok, expected.slice(0, 20)).toBe(true);
    }
  });

  it("names modified, added and missing files", async () => {
    const { call } = await connect(testDeps({ root: tmp }));
    writeFileSync(join(tmp, "evidence/logs/node-a.log"), "edited\n");
    writeFileSync(join(tmp, "evidence/extra.txt"), "new\n");
    rmSync(join(tmp, "evidence/logs/node-b.log"));
    const r = await call("verify_bundle", { path: "evidence", expected: "bundle.json" });
    const d = data(r);
    expect(d.ok).toBe(false);
    expect(d.modified.map((m: { path: string }) => m.path)).toEqual(["logs/node-a.log"]);
    expect(d.added.map((m: { path: string }) => m.path)).toEqual(["extra.txt"]);
    expect(d.missing.map((m: { path: string }) => m.path)).toEqual(["logs/node-b.log"]);
    expect(text(r)).toMatch(/^MISMATCH/);
  });

  it("rejects a malformed expectation", async () => {
    const { call } = await connect(testDeps());
    const r = await call("verify_bundle", { path: "examples/evidence", expected: '{"spec":"bundle.v0"}' });
    expect(text(r)).toMatch(/^invalid_expected: not a bundle\.v0 file/);
  });
});

describe("file access stays inside the root", () => {
  let tmp: string;
  let root: string;
  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "huygena-mcp-root-")));
    root = join(tmp, "root");
    mkdirSync(join(root, "ok"), { recursive: true });
    mkdirSync(join(tmp, "secret"));
    writeFileSync(join(tmp, "secret", "key.json"), '{"k":1}');
    writeFileSync(join(root, "ok", "a.txt"), "a");
    symlinkSync(join(tmp, "secret"), join(root, "link-out"));
    symlinkSync(join(tmp, "secret", "key.json"), join(root, "key.json"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it.each([
    ["..", "parent folder"],
    ["../secret", "sibling folder"],
    ["/etc", "absolute path"],
    ["link-out", "symlink to a folder outside"],
    ["ok/../../secret", "dot-dot inside the path"],
  ])("refuses %s (%s)", async (path) => {
    const { call } = await connect(testDeps({ root }));
    const r = await call("hash_bundle", { path });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^outside_root: /);
  });

  it("refuses documents read through a symlink that leaves the root", async () => {
    const { call } = await connect(testDeps({ root }));
    const r = await call("verify_certificate", { certificate: "key.json" });
    expect(text(r)).toMatch(/^outside_root: /);
  });

  it("allows folders inside the root, relative or absolute", async () => {
    const { call } = await connect(testDeps({ root }));
    expect((await call("hash_bundle", { path: "ok" })).isError).toBeFalsy();
    expect((await call("hash_bundle", { path: join(root, "ok") })).isError).toBeFalsy();
    expect((await call("hash_bundle", { path: "." })).isError).toBeFalsy();
  });

  it("says when a path does not exist or is not a folder", async () => {
    const { call } = await connect(testDeps({ root }));
    expect(text(await call("hash_bundle", { path: "nope" }))).toMatch(/^not_found: /);
    expect(text(await call("hash_bundle", { path: "ok/a.txt" }))).toMatch(/^not_a_directory: /);
  });

  it("takes the root from HUYGENA_MCP_ROOT, else the working directory", () => {
    expect(depsFromEnv({ HUYGENA_MCP_ROOT: "ok" }, root).root).toBe(join(root, "ok"));
    expect(depsFromEnv({}, root).root).toBe(root);
    expect(() => depsFromEnv({ HUYGENA_MCP_ROOT: "missing" }, root)).toThrow(/does not exist/);
  });

  it("turns file access off when started in / without HUYGENA_MCP_ROOT", async () => {
    expect(depsFromEnv({}, "/").root).toBeNull();
    expect(depsFromEnv({ HUYGENA_MCP_ROOT: "/" }, "/").root).toBe("/");
    const { call } = await connect(testDeps({ root: null }));
    expect(text(await call("hash_bundle", { path: "etc" }))).toMatch(/^no_root: /);
    expect(text(await call("validate_manifest", { manifest: "manifest.yaml" }))).toMatch(/^no_root: /);
    // Inline documents still work.
    expect(data(await call("validate_manifest", { manifest: example("manifest.yaml") })).ok).toBe(true);
  });

  it("treats only one-line .yaml/.yml/.json values as paths", () => {
    expect(looksLikePath("examples/manifest.yaml")).toBe(true);
    expect(looksLikePath("r.JSON")).toBe(true);
    expect(looksLikePath('{"node":"a","claims":{}}')).toBe(false);
    expect(looksLikePath("spec: manifest.v0\npaper: x.json")).toBe(false);
  });
});
