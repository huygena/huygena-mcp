# Changelog

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
