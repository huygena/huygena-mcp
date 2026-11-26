import { lintManifest, parseManifest } from "huygena-verify";
import { describe, expect, it } from "vitest";

import { AF2, AF2_SHA, connect, data, fakeFetch, gitRefs, testDeps, text, type Route } from "./helpers.js";

async function draft(routes: Route[], args: Record<string, unknown> = {}) {
  const f = fakeFetch(routes);
  const { call } = await connect(testDeps({ fetch: f.fetch }));
  const r = await call("draft_manifest", { input: "10.1038/s41586-021-03819-2", ...args });
  return { r, d: data(r), ...f };
}

/** What a person does next: fill in every placeholder. Used to show the draft is one honest edit away from passing. */
function fillIn(yaml: string): string {
  return yaml
    .replace(/description: "<[^"]*>"/, 'description: "pLDDT-weighted accuracy"\n    reported: 0.9\n    tolerance: 0.01')
    .replace(/container: "<[^"]*>"/, `container: "ghcr.io/example/af2@sha256:${"a".repeat(64)}"`)
    .replace(/sha256: "<[^"]*>"/g, (_m, i: number) => `sha256: "sha256:${i.toString(16).padStart(64, "0")}"`)
    .replace("  # seeds: [0, 1, 2]", "  seeds: [0]");
}

describe("draft_manifest", () => {
  it("drafts a schema-valid manifest for AlphaFold 2 with the repo pinned to the default branch head", async () => {
    const { r, d, calls } = await draft(AF2);
    expect(r.isError).toBeFalsy();
    expect(d.paper).toMatchObject({ id: "doi:10.1038/s41586-021-03819-2", title: "Highly accurate protein structure prediction with AlphaFold", year: 2021 });
    expect(d.paper.abstract).toMatch(/protein/i);
    expect(d.code).toMatchObject({ repo: "github.com/google-deepmind/alphafold", commit: AF2_SHA, commitSource: "default_branch_head", ref: "main" });
    expect(d.code.note).toMatch(/head of main today, not necessarily the commit the paper used/);
    expect(d.manifestYaml).toContain(`code: "github.com/google-deepmind/alphafold@${AF2_SHA}"`);
    // The head commit comes from the git ref advertisement intake already read: no API call for the commit, no token.
    expect(calls.some((c) => c.url.includes("/commits/"))).toBe(false);
    expect(calls.filter((c) => c.url.includes(".git/info/refs"))).toHaveLength(1);

    const parsed = parseManifest(d.manifestYaml);
    expect(parsed.ok).toBe(true);
    expect(parsed.manifest).toMatchObject({ spec: "manifest.v0", paper: "doi:10.1038/s41586-021-03819-2", run: { where: "gpu-tee", confirm: "independent-node" } });
    expect(d.data.total).toBeGreaterThan(d.data.included);
    expect(d.data.included).toBe(10);
  });

  it("leaves claims, container and hashes as placeholders that lint flags, never invented values", async () => {
    const { d } = await draft(AF2);
    expect(d.lint.ok).toBe(false);
    const codes = new Set(d.lint.findings.map((f: { code: string }) => f.code));
    for (const c of ["placeholder", "claim-no-reported", "claim-no-tolerance", "seeds-missing"]) expect(codes.has(c), c).toBe(true);
    expect(d.lint.findings.some((f: { path: string }) => f.path === "env.code")).toBe(false);
    const m = parseManifest(d.manifestYaml).manifest!;
    expect(m.claims[0]!.reported).toBeUndefined();
    expect(m.claims[0]!.tolerance).toBeUndefined();
    expect(d.todo.join("\n")).toMatch(/claims: add one entry per number/);
  });

  it("passes lint once a person fills in the placeholders", async () => {
    const { d } = await draft(AF2);
    const report = lintManifest(fillIn(d.manifestYaml));
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("keeps a placeholder for the commit when lookup is off", async () => {
    const { d, calls } = await draft(AF2, { resolve_commit: false });
    expect(d.code).toMatchObject({ repo: "github.com/google-deepmind/alphafold", commit: null });
    expect(d.manifestYaml).toContain('code: "github.com/google-deepmind/alphafold@<40-character commit sha>"');
    expect(d.lint.findings.some((f: { path: string; code: string }) => f.path === "env.code" && f.code === "placeholder")).toBe(true);
    expect(calls.filter((c) => c.url.includes(".git/info/refs"))).toHaveLength(1);
  });

  it("explains a failed lookup instead of guessing a commit, without mentioning tokens", async () => {
    const routes = AF2.map((r) => (/info\\\/refs/.test(r.match.source) ? { match: r.match, status: 503, body: "busy" } : r));
    const { d, r } = await draft(routes);
    expect(d.code.commit).toBeNull();
    expect(d.code.note).toMatch(/Commit lookup failed \(HTTP 503\)\. Run: git ls-remote https:\/\/github\.com\/deepmind\/alphafold/);
    expect(d.warnings[0]).toMatch(/Commit lookup .* failed/);
    expect(JSON.stringify(d)).not.toMatch(/GITHUB_TOKEN|rate limit/);
    expect(text(r)).toMatch(/commit not pinned/);
  });

  it("rejects an answer that is not a git ref advertisement", async () => {
    const routes = AF2.map((r) => (/info\\\/refs/.test(r.match.source) ? { match: r.match, body: "<html>" } : r));
    const { d } = await draft(routes);
    expect(d.code.commit).toBeNull();
  });

  it("uses a full commit from the paper's own link without asking GitHub", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const routes: Route[] = [
      { match: /export\.arxiv\.org/, body: arxivWithCode(`https://github.com/example-lab/model/tree/${sha}`) },
      { match: /api\.github\.com\/repos\/example-lab\/model$/, body: repo("example-lab/model") },
    ];
    const { d, calls } = await draft(routes, { input: "arXiv:2401.00001" });
    expect(d.paper.id).toBe("arxiv:2401.00001v1");
    expect(d.code).toMatchObject({ repo: "github.com/example-lab/model", commit: sha, commitSource: "paper_link" });
    expect(calls.some((c) => c.url.includes("/commits/"))).toBe(false);
  });

  it("resolves the tag the paper links to", async () => {
    const sha = "fedcba9876543210fedcba9876543210fedcba98";
    const routes: Route[] = [
      { match: /export\.arxiv\.org/, body: arxivWithCode("https://github.com/example-lab/model/tree/v1.0") },
      { match: /github\.com\/example-lab\/model\.git\/info\/refs/, body: gitRefs("1111111111111111111111111111111111111111", "main", [["2222222222222222222222222222222222222222", "refs/tags/v1.0"], [sha, "refs/tags/v1.0^{}"]]) },
      { match: /api\.github\.com\/repos\/example-lab\/model$/, body: repo("example-lab/model") },
    ];
    const { d } = await draft(routes, { input: "arXiv:2401.00001" });
    expect(d.code).toMatchObject({ commit: sha, commitSource: "ref_resolved", ref: "v1.0" });
  });

  it("works the same for GitLab", async () => {
    const sha = "3333333333333333333333333333333333333333";
    const routes: Route[] = [
      { match: /export\.arxiv\.org/, body: arxivWithCode("https://gitlab.com/example-lab/model") },
      { match: /gitlab\.com\/example-lab\/model\.git\/info\/refs/, body: gitRefs(sha, "master") },
    ];
    const { d } = await draft(routes, { input: "arXiv:2401.00001" });
    expect(d.code).toMatchObject({ repo: "gitlab.com/example-lab/model", commit: sha, commitSource: "default_branch_head", ref: "master" });
  });

  it("says so when the paper links no code", async () => {
    const { d } = await draft([{ match: /export\.arxiv\.org/, file: "arxiv-attention.xml" }], { input: "1706.03762" });
    expect(d.code.repo).toBeNull();
    expect(d.manifestYaml).toContain('code: "<host>/<org>/<repo>@<40-character commit sha>"');
    expect(d.todo[0]).toMatch(/links no code of its own/);
    expect(parseManifest(d.manifestYaml).ok).toBe(true);
  });
});

function repo(full: string): string {
  return JSON.stringify({ full_name: full, default_branch: "main", license: { spdx_id: "MIT" }, stargazers_count: 3, pushed_at: "2024-01-02T00:00:00Z", archived: false, fork: false, description: null });
}

/** A minimal arXiv API answer for a made-up paper whose abstract links its code. */
function arxivWithCode(url: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <updated>2024-01-01T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>An Example Model</title>
    <summary>We propose a model. Our code is available at ${url}.</summary>
    <author><name>Ada Example</name></author>
    <link href="http://arxiv.org/abs/2401.00001v1" rel="alternate" type="text/html"/>
    <arxiv:primary_category term="cs.LG"/>
  </entry>
</feed>`;
}
