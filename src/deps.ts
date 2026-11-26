import { realpathSync, statSync } from "node:fs";
import { parse, resolve } from "node:path";

import type { FetchLike } from "huygena-intake";

export const SERVER_NAME = "huygena-mcp";
export const SERVER_VERSION = "0.5.0";
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (+https://github.com/huygena/huygena-mcp)`;

/** Everything a tool needs. Built from the environment in index.ts, injected in tests. */
export type Deps = {
  /**
   * Real path of the only folder the file tools may read. null turns the file tools off:
   * that happens when HUYGENA_MCP_ROOT is unset and the server was started in the filesystem root.
   */
  root: string | null;
  /** fetch for every outbound call (Crossref, arXiv, bioRxiv, NCBI, Europe PMC, code hosts). Default: global fetch. */
  fetch?: FetchLike;
  /** Contact email for Crossref's polite pool and NCBI. Sent only to those two. */
  mailto?: string;
  log: (message: string) => void;
};

/** Build the dependencies from the environment. Logs go to stderr: stdout carries the MCP protocol. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Deps {
  const explicit = env.HUYGENA_MCP_ROOT?.trim();
  const wanted = explicit || cwd;
  let root: string;
  try {
    root = realpathSync(resolve(cwd, wanted));
  } catch {
    throw new Error(`HUYGENA_MCP_ROOT ${JSON.stringify(wanted)} does not exist`);
  }
  if (!statSync(root).isDirectory()) throw new Error(`HUYGENA_MCP_ROOT ${JSON.stringify(wanted)} is not a directory`);
  return {
    // Some clients start servers in /. Reading the whole disk by default is not acceptable; it has to be asked for.
    root: !explicit && parse(root).root === root ? null : root,
    mailto: env.HUYGENA_MAILTO?.trim() || "",
    log: (message) => process.stderr.write(`[huygena-mcp] ${message}\n`),
  };
}
