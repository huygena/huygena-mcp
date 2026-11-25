#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { depsFromEnv, SERVER_VERSION } from "./deps.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const deps = depsFromEnv();
  const files = deps.root ? `file tools read only under ${deps.root}` : "file tools off (started in / without HUYGENA_MCP_ROOT)";
  deps.log(`v${SERVER_VERSION}, ${files}${deps.githubToken ? ", GITHUB_TOKEN set" : ""}`);
  await createServer(deps).connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`huygena-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
