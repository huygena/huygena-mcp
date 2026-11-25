# Security

Please report vulnerabilities privately to **cto@huygena.xyz**. Do not open a public issue.

Include what you found, how to reproduce it and what it affects. We will reply within a few days.

In scope:

- Any tool reading a file or folder outside `HUYGENA_MCP_ROOT`: path traversal, symlinks, absolute paths, encodings.
- Any tool writing to disk, or sending file contents anywhere. None of them should.
- `GITHUB_TOKEN` or `HUYGENA_MAILTO` sent to a host other than api.github.com (token) or Crossref and NCBI (email).
- A tool reporting a pass it should not: a verdict, bundle match or certificate check that does not follow from the inputs. Issues in the checks themselves may belong to [huygena-verify](https://github.com/huygena/huygena-verify/blob/main/SECURITY.md); report them either way.
- A crafted input that crashes or hangs the server.

Out of scope for this version: TEE attestation signature checks, on-chain lookups, bounties and runs. They are not implemented and no tool claims them.
