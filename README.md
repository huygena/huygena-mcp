# huygena-mcp

**An MCP server that lets an AI agent check whether a paper can be re-run, draft the run manifest, and verify the results against tolerances written before the run.**

huygena-mcp puts the two open-source Huygena libraries behind the [Model Context Protocol](https://modelcontextprotocol.io):

- [huygena-intake](https://github.com/huygena/huygena-intake) turns a DOI, arXiv, bioRxiv or PubMed ID into a replication brief. It covers the paper's own code (checked on GitHub), its data, its license and a readiness verdict with reasons.
- [huygena-verify](https://github.com/huygena/huygena-verify) lints run manifests, hashes evidence folders, computes per-claim verdicts and re-checks certificates. All of it runs offline.

Paper lookups use public APIs with no keys. All other tools run locally. The server never writes files, and it never starts a run or spends money.

## Tools

| Tool | Input | What it returns | Network |
|---|---|---|---|
| `paper_intake` | `input`, `full_text?`, `check_github?` | Replication brief: metadata, access and license, primary vs mentioned code links with GitHub status, data links and accessions, availability statements, readiness `ready` / `partial` / `not_ready` with a reason per check | Crossref, arXiv, bioRxiv, NCBI, Europe PMC, GitHub |
| `literature_search` | `query`, `limit?`, `sort?`, `timeout_seconds?` | Europe PMC hits with DOI, PMID/PMCID, year, journal, open-access flag, citation count | Europe PMC |
| `draft_manifest` | `input`, `resolve_commit?` | A `manifest.v0` YAML skeleton for the paper, its lint report, a to-do list and the abstract | as `paper_intake`, plus one GitHub request |
| `validate_manifest` | `manifest` | Schema and lint findings (severity, rule id, path) and the manifest hash a certificate anchors | none |
| `compare_claims` | `manifest`, `results` (1 or 2 nodes), `partial_factor?` | Per-claim verdict, delta and reason; mismatches between nodes; results that ran a different manifest | none |
| `hash_bundle` | `path`, `ignore?` | Evidence bundle: SHA-256 and size per file, and a root hash you can recompute with `sha256sum` | none |
| `verify_bundle` | `path`, `expected`, `ignore?` | Match or not, with every modified, added and missing file | none |
| `verify_certificate` | `certificate`, `manifest?`, `bundle_path?`, `ignore?` | Each check as `pass`, `fail`, `skipped` or `planned` | none |

Notes on the inputs:

- Document inputs (`manifest`, `results`, `certificate`, `expected`) take inline text or a path to a `.yaml`, `.yml` or `.json` file under the server root.
- `expected` also takes a bare root hash.
- Every tool returns a short text summary, the same data as JSON text, and `structuredContent`.

Verdicts are `Replicated`, `Partially replicated`, `Failed` and `Could not run`. With two nodes, a claim gets a verdict only when both agree. Failed means the result was not reproduced with the published code and data. It never means fraud.

### Resources

| URI | Content |
|---|---|
| `huygena://schema/manifest.v0` | JSON Schema for run manifests |
| `huygena://schema/results.v0` | JSON Schema for one node's results |
| `huygena://schema/bundle.v0` | JSON Schema for evidence bundles |
| `huygena://schema/certificate.v0` | JSON Schema for certificates |
| `huygena://rules/verdicts` | Tolerance and verdict rules (draft v0), from huygena-verify's SPEC.md |
| `huygena://spec/v0` | The full huygena-verify SPEC |

## Setup

Node 20 or newer.

### Claude Code

```sh
claude mcp add huygena -- npx -y github:huygena/huygena-mcp
```

The file tools only read under the folder you start Claude Code in. To point them at another folder:

```sh
claude mcp add huygena -e HUYGENA_MCP_ROOT=/path/to/replications -- npx -y github:huygena/huygena-mcp
```

### Claude Desktop, Cursor and other clients

Claude Desktop uses `claude_desktop_config.json`. Cursor uses `~/.cursor/mcp.json` or `.cursor/mcp.json` in a project.

```json
{
  "mcpServers": {
    "huygena": {
      "command": "npx",
      "args": ["-y", "github:huygena/huygena-mcp"],
      "env": {
        "HUYGENA_MCP_ROOT": "/path/to/replications"
      }
    }
  }
}
```

Set `HUYGENA_MCP_ROOT` for desktop clients. They often start servers in `/`, and in that case the file tools stay off (see [Filesystem access](#filesystem-access)).

### How the GitHub install works

The package is not on npm yet. `npx github:huygena/huygena-mcp` clones this repo, installs `huygena-intake` and `huygena-verify` from GitHub, and runs each repo's `prepare` script to build it. The first start takes about half a minute. Later starts come from the npx cache.

This path was tested with npm 11. pnpm 12 blocks git-hosted sub-dependencies and their build scripts by default, so `pnpm dlx` will not work. Use `npx`, or build from source.

### Build from source

Clone the three repos next to each other. In this repo, `pnpm-workspace.yaml` links `../huygena-intake` and `../huygena-verify` in place of the GitHub copies.

```sh
git clone https://github.com/huygena/huygena-intake.git
git clone https://github.com/huygena/huygena-verify.git
git clone https://github.com/huygena/huygena-mcp.git
(cd huygena-intake && pnpm install && pnpm build)
(cd huygena-verify && pnpm install && pnpm build)
cd huygena-mcp && pnpm install && pnpm build
claude mcp add huygena -- node "$PWD/dist/index.js"
```

## Configuration

| Variable | Default | |
|---|---|---|
| `HUYGENA_MCP_ROOT` | the working directory | The only folder the file tools may read. If unset and the working directory is `/`, file tools are off |
| `GITHUB_TOKEN` | none | Raises GitHub's limit from 60 to 5,000 requests an hour. Sent only to api.github.com |
| `HUYGENA_MAILTO` | none | Contact email for Crossref's polite pool and NCBI. Sent only to those two |

Logs go to stderr. Stdout carries the MCP protocol.

## Example

These are real responses from `pnpm smoke` on 2026-11-25: the built server over stdio, live APIs for the paper, huygena-verify's `examples/` for the rest. Long output is trimmed where marked.

**`paper_intake { "input": "10.1038/s41586-021-03819-2" }`** (13.9 s; Europe PMC was slow that day)

```text
Highly accurate protein structure prediction with AlphaFold
John Jumper, Richard Evans, Alexander Pritzel +31 more · Nature · 2021
doi:10.1038/s41586-021-03819-2  PMID 34265844  PMC8371605
Open access: yes, CC-BY-4.0 (Crossref license) · full text read from PMC (NCBI) PMC8371605

Readiness  READY  All 5 core checks pass
  pass  code_found              The paper links its own code: github.com/deepmind/alphafold
  pass  code_reachable          github.com/google-deepmind/alphafold is live on GitHub (default
                                branch main, last push 2026-04-22)
  pass  code_license            Apache-2.0 (detected by GitHub in google-deepmind/alphafold)
  pass  data_found              16 links to datasets or database records
  pass  open_access             Free to read (CC-BY-4.0); source: Crossref license
  warn  code_snapshot           Code lives only in a git repository that can change after
                                publication; a run must pin a commit (advisory)
  pass  availability_statement  Found: code availability and data availability (advisory)

Code  1 from the paper, 21 tools mentioned
  github.com/deepmind/alphafold
      live · Apache-2.0 · 14,956 stars · branch main · last push 2026-04-22
      Repository moved: deepmind/alphafold now redirects to google-deepmind/alphafold
[…]
```

**`draft_manifest { "input": "10.1038/s41586-021-03819-2" }`**

```text
Draft manifest for: Highly accurate protein structure prediction with AlphaFold
paper doi:10.1038/s41586-021-03819-2 · readiness READY · code github.com/google-deepmind/alphafold@c77e5d2a8961d1a353632c462914ff0a32a950f6 (default branch head) · 10 of 16 data links
lint: 14 errors, 1 warning. Errors are the parts a person must fill in; the draft is not runnable until lint passes.

spec: manifest.v0
paper: "doi:10.1038/s41586-021-03819-2"
title: "Highly accurate protein structure prediction with AlphaFold"
claims:
  - id: todo.claim_1
    description: "<which number this is, e.g. Table 2 AUROC on the test split>"
    # reported: <the value printed in the paper>
    # tolerance: <abs band, or { abs: <number>, rel: <fraction> }>
env:
  container: "<registry/image>@sha256:<64-hex digest>"
  # c77e5d2a8961d1a353632c462914ff0a32a950f6 is the head of main today, not necessarily the commit the paper used. The paper was published 2021-07-15; check the tags and releases from then.
  code: "github.com/google-deepmind/alphafold@c77e5d2a8961d1a353632c462914ff0a32a950f6"
  data:
    - url: "https://www.wwpdb.org/ftp/pdb-ftp-sites"
      sha256: "<sha256 of the downloaded file>"
    - url: "https://www.rcsb.org/structure/6Y4F"  # pdb 6Y4F
      sha256: "<sha256 of the downloaded file>"
[… 8 more data entries, seeds and run settings, then the to-do list]
```

The draft pins what it can verify and leaves the rest as placeholders that lint flags:

- `paper` comes from the paper record. `code` is pinned to a commit GitHub reported, and the comment says which commit that is.
- Claims, the container digest, data hashes and seeds are placeholders. They have to come from a person reading the paper.

**`compare_claims { "manifest": "examples/manifest.yaml", "results": ["examples/results.node-a.json", "examples/results.node-b.json"] }`**

```text
6 claims · nodes node-a + node-b · rules v0-draft, partial factor 3
2 Replicated · 1 Partially replicated · 1 Failed · 1 Could not run · 1 mismatch
manifest sha256:3183bd7cd87ba9fcafeed9723ab55255e3d07bcf4b76be55c1759c72d911fbce

  table_2.auroc                Replicated            reported 0.912  node-a=0.9104 node-b=0.9109
                               within ±0.005, on both nodes
  table_2.auprc                Replicated            reported 0.687  node-a=0.6791 node-b=0.6802
                               within ±0.01374, on both nodes
  figure_3b.slope              Partially replicated  reported 0.84  node-a=0.79 node-b=0.788
                               outside ±0.02, within partial ±0.06, same direction, on both nodes
  table_3.hazard_ratio         Failed                reported 0.71  node-a=1.04 node-b=1.05
                               opposite side of the value of no effect (1) from the paper, on both nodes
  table_4.ece                  MISMATCH              reported 0.031  node-a=0.0335 node-b=0.0362
                               nodes disagree: node-a Replicated (within ±0.004); node-b Partially replicated (outside ±0.004, within partial ±0.012, same direction)
  supp_table_2.external_auroc  Could not run         reported 0.874  node-a=- node-b=-
                               external validation cohort is not public (data access agreement required), on both nodes

Failed means not reproduced with the published code and data. It never means fraud.
```

The example paper, values and nodes are made up for huygena-verify's examples. The DOI uses `10.5555`, the prefix Crossref reserves for examples.

**`verify_certificate`** on the example certificate, with the manifest and evidence folder:

```text
OK    no check failed · 8 pass · 0 fail · 0 skipped · 2 planned
  […]
  planned  attestation-signature  not implemented in this version: checking the report against NVIDIA remote attestation and Intel TDX quote verification
  planned  onchain-record         not implemented: Huygena contracts are not deployed yet, so there is no record to read
```

## Filesystem access

`hash_bundle`, `verify_bundle`, `verify_certificate` (with `bundle_path`) and file-path document inputs read from disk. They are fenced in:

- **One root folder.** It is `HUYGENA_MCP_ROOT`, or the working directory when that is unset. Paths are resolved against it.
- **No escaping.** A path is resolved to its real path first, with symlinks followed. If the result is outside the root, the call fails with `outside_root`. That covers `..`, absolute paths and symlinks inside the root that point out.
- **No whole-disk default.** If `HUYGENA_MCP_ROOT` is unset and the server starts in `/`, which some desktop clients do, file tools return `no_root`. Inline documents still work. Setting `HUYGENA_MCP_ROOT=/` turns full access on, if you mean it.
- **Read only.** Nothing is written, and file contents are never sent over the network.
- **Limits.** Document files are capped at 5 MB. Hashing streams files, so evidence folders can be any size. Symlinks inside an evidence folder are not followed and are listed as skipped.

## Errors

Failures come back as MCP tool errors, as `code: message` text the model can act on. They never crash the server or show up as protocol errors. The codes are:

- From intake: `invalid_id`, `not_found`, `upstream`, `timeout`.
- From the file tools: `outside_root`, `no_root`, `not_a_directory`.
- From documents and verdicts: `invalid_manifest`, `invalid_results`, `invalid_expected`, `compare_failed`.

A slow Europe PMC does not fail `paper_intake`: the brief comes back with a note in `warnings`.

## Planned

These are not live, and no tool here pretends they are:

- **Replication and research runs over MCP** (whitepaper utility 41). An agent would request a replication or fund a bounty on a paper, a GPU TEE node would re-run it, a second node would confirm, and the certificate would go on-chain. Huygena contracts are not deployed yet. See https://docs.huygena.xyz/open-items.
- **Agent payments over x402** (utility 42). Agents would pay for runs per call in USDG, without an account. Chain and launch details are still open items.
- **Attestation and on-chain checks in `verify_certificate`.** These are reported as `planned` until the contracts and attestation verification exist.

## How it fits Huygena

Huygena is a replication market for science. Agents re-run computational papers on GPU TEEs, a second node confirms the result, and the outcome becomes an on-chain certificate. This server covers the steps around the run:

- **Before:** is the paper re-runnable, and what exactly must be pinned.
- **After:** do the numbers hold, and does the evidence match the certificate.

All of these work today.

- App preview, including paper lookup: https://preview.huygena.xyz
- Docs: https://docs.huygena.xyz

## Development

```sh
pnpm install            # links ../huygena-intake and ../huygena-verify (build them first)
pnpm typecheck && pnpm test && pnpm build
pnpm smoke              # built server over stdio, live APIs for AlphaFold 2, verify's examples for the rest
```

Tests run offline. They use an in-memory MCP client, recorded API responses, and huygena-verify's `examples/`. CI checks out the two sibling repos next to this one and builds them first.

## License

Apache-2.0. Copyright 2026 Huygena.
