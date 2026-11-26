import type { Brief, CodeLink, DataLink } from "huygena-intake";
import { lintManifest, type Finding } from "huygena-verify";

import { USER_AGENT, type Deps } from "./deps.js";

/** Data links written into the draft. The rest are counted in `todo`. */
export const MAX_DRAFT_DATA = 10;
const COMMIT_TIMEOUT_MS = 15_000;
const FULL_SHA = /^[0-9a-f]{40}$/i;

export type CommitSource = "paper_link" | "ref_resolved" | "default_branch_head";

export interface DraftCode {
  /** `host/org/repo` written into env.code, or null when the paper links no code. */
  repo: string | null;
  url: string | null;
  /** Full commit SHA, only when it came from the paper link or from GitHub. Never guessed. */
  commit: string | null;
  commitSource: CommitSource | null;
  /** The branch or tag the commit was resolved from. */
  ref: string | null;
  note: string;
  /** Other primary code links the paper gives, not used in env.code. */
  others: string[];
}

export interface Draft {
  manifestYaml: string;
  paper: { id: string | null; title: string; venue: string | null; year: number | null; published: string | null; abstract: string | null };
  readiness: { level: Brief["readiness"]["level"]; summary: string };
  code: DraftCode;
  data: { included: number; total: number };
  lint: { ok: boolean; errors: number; warnings: number; infos: number; findings: Finding[] };
  /** What a person still has to fill in or check before this manifest can be run. */
  todo: string[];
  /** Problems met while drafting (GitHub limits, brief warnings). */
  warnings: string[];
}

export interface DraftOptions {
  /** Ask GitHub for the commit behind the default branch (or the linked tag/branch). Default true. */
  resolveCommit?: boolean;
  signal?: AbortSignal;
  /** For tests: the date written into the header comment. */
  now?: Date;
}

/** Turn a brief into a manifest.v0 skeleton. Everything that cannot be known from the paper is left as a <placeholder>. */
export async function draftManifest(deps: Deps, brief: Brief, opts: DraftOptions = {}): Promise<Draft> {
  const todo: string[] = [];
  const warnings: string[] = [];
  const p = brief.paper;

  // paper
  // arXiv's DataCite DOI (10.48550/arXiv.…) has no version, so the versioned arXiv id names the exact text read.
  let paperId: string | null = null;
  const arxivDoi = !!p.doi && /^10\.48550\/arxiv\./i.test(p.doi);
  if (p.arxivId && (!p.doi || arxivDoi)) paperId = `arxiv:${p.arxivId}${p.version ? `v${p.version}` : ""}`;
  else if (p.doi) paperId = `doi:${p.doi}`;
  else todo.push(`paper: this record has no DOI or arXiv id (${brief.id.canonical}). Manifests need one; find the DOI and fill it in.`);
  if (p.publishedDoi && p.publishedDoi !== p.doi) {
    todo.push(`paper: this is a preprint with a journal version (doi:${p.publishedDoi}). Decide which one the claims come from; numbers can change between versions.`);
  }

  // code
  const code = await pickCode(deps, brief, opts, warnings);
  if (!code.repo) todo.push("env.code: the paper links no code of its own. Find the repository (ask the authors) and pin a full commit SHA.");
  else if (!code.commit) todo.push(`env.code: pin a full 40-character commit SHA for ${code.repo}. ${code.note}`);
  else if (code.commitSource === "default_branch_head") todo.push(`env.code: ${code.note}`);
  if (code.others.length) todo.push(`env.code: the paper also links ${code.others.join(", ")}. A manifest pins one repository; vendor or pin the others inside the container.`);
  const archive = brief.code.find((c) => c.role === "primary" && ["zenodo", "software_heritage", "code_ocean", "figshare", "osf"].includes(c.host));
  if (archive) todo.push(`env.code: the paper archived its code at ${archive.url}. Prefer the commit that archive was made from.`);

  // data
  const data = [...brief.data].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "link" ? -1 : 1));
  const included = data.slice(0, MAX_DRAFT_DATA);
  if (data.length === 0) todo.push("env.data: no dataset links found. Add the sha256 of every input file, or leave data out only if the run downloads nothing.");
  else {
    todo.push(`env.data: download each dataset the run needs, write its sha256 (sha256sum <file>), and remove entries the run does not use.`);
    if (data.length > included.length) todo.push(`env.data: ${data.length - included.length} more data links are in the brief and were left out of the draft.`);
  }

  todo.push("env.container: build the environment at the pinned commit, push the image and pin it by digest (name@sha256:<64 hex>).");
  todo.push("env.seeds: list the random seeds the paper used, or seeds: [] if no step draws random numbers.");
  todo.push("claims: add one entry per number to re-check, with reported, tolerance and null_value. Write the tolerance before any run.");

  const yaml = renderYaml({ brief, paperId, code, data: included, now: opts.now ?? new Date() });
  const report = lintManifest(yaml);
  return {
    manifestYaml: yaml,
    paper: { id: paperId, title: p.title, venue: p.venue, year: p.year, published: p.published, abstract: p.abstract },
    readiness: { level: brief.readiness.level, summary: brief.readiness.summary },
    code,
    data: { included: included.length, total: data.length },
    lint: { ok: report.ok, errors: report.errors, warnings: report.warnings, infos: report.infos, findings: report.findings },
    todo,
    warnings: [...warnings, ...brief.warnings],
  };
}

const GIT_HOSTS = ["github", "gitlab", "bitbucket", "codeberg"];

function primaryCode(brief: Brief): CodeLink[] {
  const primary = brief.code.filter((c) => c.role === "primary");
  const rank = (c: CodeLink) => (c.repo?.status === "ok" ? 0 : c.repo?.status === "unchecked" ? 1 : 3);
  return [...primary].sort((a, b) => rank(a) - rank(b));
}

async function pickCode(deps: Deps, brief: Brief, opts: DraftOptions, warnings: string[]): Promise<DraftCode> {
  const repos = primaryCode(brief).filter((c) => GIT_HOSTS.includes(c.host));
  const first = repos[0];
  const others = repos.slice(1).map((c) => c.url);
  if (!first) return { repo: null, url: null, commit: null, commitSource: null, ref: null, note: "No repository link in the paper.", others };

  const check = first.repo;
  const id = check?.fullName ?? first.id;
  const host = new URL(first.url).host.replace(/^www\./, "");
  const repo = id ? `${host}/${id}` : null;
  const base = { repo, url: first.url, others };
  const gitUrl = first.url.replace(/\/+$/, "").replace(/\.git$/i, "");

  if (first.ref && FULL_SHA.test(first.ref)) {
    return { ...base, commit: first.ref.toLowerCase(), commitSource: "paper_link", ref: null, note: "Commit taken from the link in the paper." };
  }
  if (check?.status === "not_found") {
    return { ...base, commit: null, commitSource: null, ref: first.ref, note: `${first.url} is not reachable (private, deleted or moved without a redirect).` };
  }
  const ref = first.ref ?? check?.defaultBranch ?? null;
  if (opts.resolveCommit === false) {
    return { ...base, commit: null, commitSource: null, ref, note: "Commit lookup was turned off (resolve_commit: false)." };
  }

  // No ref in the link: the intake brief already holds the head of the default branch (read over git).
  let sha = !first.ref && check?.head && FULL_SHA.test(check.head) ? check.head.toLowerCase() : null;
  if (!sha) {
    const r = await gitResolve(deps, gitUrl, first.ref, opts.signal);
    if (!r.sha) {
      warnings.push(`Commit lookup for ${repo ?? first.url}${ref ? `@${ref}` : ""} failed: ${r.error}`);
      return { ...base, commit: null, commitSource: null, ref, note: `Commit lookup failed (${r.error}). Run: git ls-remote ${gitUrl}${ref ? ` ${ref}` : ""}` };
    }
    sha = r.sha;
  }
  if (first.ref) {
    return { ...base, commit: sha, commitSource: "ref_resolved", ref, note: `Commit behind "${ref}", the ref the paper links to.` };
  }
  const branch = ref ?? "the default branch";
  const when = brief.paper.published ? ` The paper was published ${brief.paper.published}; check the tags and releases from then.` : "";
  return {
    ...base,
    commit: sha,
    commitSource: "default_branch_head",
    ref,
    note: `${sha} is the head of ${branch} today, not necessarily the commit the paper used.${when}`,
  };
}

/**
 * Resolve a branch or tag to a full commit SHA with the git protocol (what `git ls-remote` does), on any git host.
 * `ref` null means HEAD. No API and no token.
 */
export async function gitResolve(deps: Deps, repoUrl: string, ref: string | null, signal?: AbortSignal): Promise<{ sha: string | null; error: string | null }> {
  const f = deps.fetch ?? globalThis.fetch;
  const signals = [AbortSignal.timeout(COMMIT_TIMEOUT_MS), ...(signal ? [signal] : [])];
  try {
    const res = await f(`${repoUrl}.git/info/refs?service=git-upload-pack`, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" }, signal: AbortSignal.any(signals) });
    const text = await res.text();
    if (!res.ok) return { sha: null, error: `HTTP ${res.status}` };
    if (!text.includes("# service=git-upload-pack")) return { sha: null, error: "the host did not answer as a git repository" };
    const refs = new Map<string, string>();
    for (const m of text.matchAll(/([0-9a-f]{40}) ([^\s\0]+)/g)) if (!refs.has(m[2]!)) refs.set(m[2]!, m[1]!);
    const sha = ref
      ? (refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`) ?? refs.get(`refs/heads/${ref}`) ?? refs.get(ref) ?? null)
      : (refs.get("HEAD") ?? null);
    return sha ? { sha, error: null } : { sha: null, error: ref ? `no branch or tag named "${ref}"` : "no HEAD advertised" };
  } catch (e) {
    const err = e as Error;
    return { sha: null, error: err.name === "TimeoutError" ? `timed out after ${COMMIT_TIMEOUT_MS / 1000}s` : `network error: ${err.message}` };
  }
}

/** YAML double-quoted scalar. JSON string escapes are valid YAML. */
const q = (s: string) => JSON.stringify(s);
/** Text safe for a one-line YAML comment. */
const c = (s: string) => s.replace(/\s+/g, " ").trim();

/** A trailing comment naming the repository and record, or nothing when it would only repeat the URL. */
function dataLabel(d: DataLink): string {
  if (d.repository === "other" && !d.id) return "";
  return `  # ${c(`${d.repository}${d.id ? ` ${d.id}` : ""}${d.kind === "accession" ? " (accession)" : ""}`)}`;
}

function renderYaml(x: { brief: Brief; paperId: string | null; code: DraftCode; data: DataLink[]; now: Date }): string {
  const { brief, paperId, code, data } = x;
  const p = brief.paper;
  const day = x.now.toISOString().slice(0, 10);
  const venue = [p.venue, p.year].filter(Boolean).join(" ");
  const L: string[] = [];
  L.push("# Huygena run manifest, spec v0 (draft).");
  L.push(`# Drafted by huygena-mcp from a huygena-intake brief on ${day}. Review every line.`);
  L.push(`# Paper: ${c(p.title)}${venue ? ` (${c(venue)})` : ""}`);
  L.push(`# Readiness: ${brief.readiness.level.toUpperCase()}: ${c(brief.readiness.summary)}`);
  L.push("# Every <placeholder> is a lint error until it is filled in. Check it with validate_manifest.");
  L.push("spec: manifest.v0");
  L.push("");
  L.push(`paper: ${q(paperId ?? `<DOI or arXiv id; ${brief.id.canonical} has none>`)}`);
  L.push(`title: ${q(p.title)}`);
  L.push("");
  L.push("# One entry per number in the paper you want re-checked. The tolerance is written BEFORE the run:");
  L.push("# abs, rel (fraction of |reported|), or both. null_value is the value of no effect");
  L.push("# (0 for differences and slopes, 1 for ratios, 0.5 for AUROC).");
  L.push("claims:");
  L.push("  - id: todo.claim_1");
  L.push(`    description: ${q("<which number this is, e.g. Table 2 AUROC on the test split>")}`);
  L.push("    # reported: <the value printed in the paper>");
  L.push("    # tolerance: <abs band, or { abs: <number>, rel: <fraction> }>");
  L.push("    # null_value: <value of no effect>");
  L.push("");
  L.push("env:");
  L.push("  # Build the environment at the pinned commit, push the image, pin it by digest, not by tag.");
  L.push(`  container: ${q("<registry/image>@sha256:<64-hex digest>")}`);
  if (code.repo && code.commit) {
    L.push(`  # ${c(code.note)}`);
    L.push(`  code: ${q(`${code.repo}@${code.commit}`)}`);
  } else if (code.repo) {
    L.push(`  # ${c(code.note)}`);
    L.push(`  code: ${q(`${code.repo}@<40-character commit sha>`)}`);
  } else {
    L.push("  # The paper links no code of its own.");
    L.push(`  code: ${q("<host>/<org>/<repo>@<40-character commit sha>")}`);
  }
  if (code.others.length) L.push(`  # Also linked as the paper's code: ${c(code.others.join(", "))}`);
  if (data.length) {
    L.push("  # Datasets found in the paper. Hash each file the run reads and remove the ones it does not.");
    L.push("  data:");
    for (const d of data) {
      L.push(`    - url: ${q(d.url)}${dataLabel(d)}`);
      L.push(`      sha256: ${q("<sha256 of the downloaded file>")}`);
    }
  } else {
    L.push("  # No dataset links were found in the paper.");
    L.push(`  data:`);
    L.push(`    - ${q("sha256:<dataset hash>")}`);
  }
  L.push("  # seeds: [0, 1, 2]            # the seeds the paper used; [] only if nothing is random");
  L.push('  # command: ["python", "reproduce.py"]');
  L.push("");
  L.push("run:");
  L.push("  where: gpu-tee             # gpu-tee on Huygena, local for a re-run kit");
  L.push("  confirm: independent-node  # a second node re-runs before any verdict");
  return `${L.join("\n")}\n`;
}
