# Changelog

## v0.6.0 · 2026-11-28

Reads Huygena's live contracts on Robinhood Chain. Still read-only: no tool signs, posts, funds or spends.

- New tool `read_bounties`: USDG bounties in HuygenaEscrow. One by id, every bounty for a paper (`doi:…`, `arxiv:…`, `biorxiv:…`), or the newest. Status, USDG escrowed, deadline, the fee and confirmer share fixed at creation, and the certificate that settled it.
- New tool `read_certificate`: one certificate from HuygenaCertificates by run id, with paper key, bounty, hashes, both nodes and one verdict per claim.
- `verify_certificate` takes `onchain`: the `onchain-record` check compares the certificate with its contract record. Without it the check is `skipped` (it was `planned`).
- `HUYGENA_RPC_URL` sets the JSON-RPC endpoint. Default: a public Robinhood Chain RPC.
- `huygena-verify` v0.3.0.

## v0.5.0 · 2026-11-26

No token, no GitHub API dependency.

- `huygena-intake` v0.8.0: code links on any host (GitHub, GitLab, Codeberg, Bitbucket, archives) are checked over the git protocol or by URL. Briefs now carry `code[].repo` instead of `code[].github`.
- `draft_manifest` resolves commits over the git protocol (the request `git ls-remote` makes), on any git host. The default branch head comes from the brief, so most drafts make no extra request.
- `GITHUB_TOKEN` is no longer read or sent anywhere.
- `paper_intake` takes `check_repos`; `check_github` still works.

## v0.4.0 · 2026-11-26

Same tools, resources and error codes as 0.1.0.

- Dependencies pinned to released versions: `huygena-intake` v0.7.0 (runs on edge runtimes) and `huygena-verify` v0.2.0 (Windows fix for `hash_bundle` output paths), instead of whatever was on `main`.
- Live smoke test reports a Europe PMC outage in its output instead of failing.
- README links point to huygena.xyz and to paper lookup at dapp.huygena.xyz/papers.
- Tagged releases are built, tested and published by `.github/workflows/release.yml`.

## v0.1.0 · 2026-11-25

First release. A stdio MCP server over [huygena-intake](https://github.com/huygena/huygena-intake) and [huygena-verify](https://github.com/huygena/huygena-verify).

- `paper_intake`: paper ID or link to a replication brief (metadata, access, code and data links, GitHub checks, readiness verdict).
- `literature_search`: Europe PMC search with a caller-set timeout.
- `draft_manifest`: manifest.v0 skeleton for a paper. Pins the paper's repository to a full commit SHA when one can be known (from the paper's link, the tag or branch it links, or the default branch head, labeled as such). Claims, container digest, data hashes and seeds stay as placeholders that lint flags.
- `validate_manifest`: schema and lint findings plus the manifest hash.
- `compare_claims`: per-claim verdicts from one or two nodes' results; flags results that ran a different manifest.
- `hash_bundle` and `verify_bundle`: content-addressed evidence bundles; names modified, added and missing files.
- `verify_certificate`: re-checks a certificate.v0. Attestation signatures and the on-chain record are reported as `planned`.
- Resources: the four v0 JSON Schemas, the tolerance and verdict rules, and the full SPEC.
- File tools read only under `HUYGENA_MCP_ROOT` (default: the working directory); paths that resolve outside it, including through symlinks, are refused.
- Errors come back as MCP tool errors with a stable code (`invalid_id`, `timeout`, `outside_root`, `invalid_manifest`, …).
