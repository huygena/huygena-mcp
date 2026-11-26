import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "huygena-intake";

import type { Deps } from "../src/deps.js";
import { createServer } from "../src/server.js";

/** The installed huygena-verify package; its examples/ folder is the shared test data. */
export const VERIFY_DIR = dirname(createRequire(import.meta.url).resolve("huygena-verify/package.json"));
export const EXAMPLES = join(VERIFY_DIR, "examples");
export const example = (name: string) => readFileSync(join(EXAMPLES, name), "utf8");

/** Recorded API responses, copied from huygena-intake's tests. */
export function fx(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export interface Route {
  match: RegExp;
  status?: number;
  file?: string;
  body?: string;
  error?: Error;
}

export function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

/** A fetch that answers from fixtures. Unrouted URLs get a 404 and are listed in `unrouted`. */
export function fakeFetch(routes: Route[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const unrouted: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = routes.find((x) => x.match.test(url));
    if (!r) {
      unrouted.push(url);
      return new Response("not found", { status: 404 });
    }
    if (r.error) throw r.error;
    return new Response(r.file ? fx(r.file) : (r.body ?? ""), { status: r.status ?? 200 });
  };
  return { fetch, calls, unrouted };
}

export const AF2_SHA = "8d4fd5f9ea0dd20f3fa4f9dc1ef12a2bb01cdb4f";

/** A git-upload-pack ref advertisement (`<repo>.git/info/refs`), with extra `[sha, ref]` lines. */
export function gitRefs(head: string, branch = "main", extra: [string, string][] = []): string {
  const pkt = (l: string) => `${(l.length + 4).toString(16).padStart(4, "0")}${l}`;
  const lines = [pkt(`${head} HEAD\0multi_ack symref=HEAD:refs/heads/${branch} agent=git/test\n`), pkt(`${head} refs/heads/${branch}\n`), ...extra.map(([sha, ref]) => pkt(`${sha} ${ref}\n`))];
  return `001e# service=git-upload-pack\n0000${lines.join("")}0000`;
}

/** AlphaFold 2 (10.1038/s41586-021-03819-2) as Crossref, NCBI, Europe PMC and GitHub answered it. The commit is made up for tests. */
export const AF2: Route[] = [
  { match: /api\.crossref\.org\/works\/10\.1038/, file: "crossref-alphafold2.json" },
  { match: /idconv/, file: "idconv-alphafold2.json" },
  { match: /efetch\.fcgi\?db=pmc&id=8371605/, file: "pmc-alphafold2.xml" },
  { match: /europepmc\/webservices\/rest\/search/, file: "epmc-alphafold2.json" },
  { match: /github\.com\/deepmind\/alphafold\.git\/info\/refs/, body: gitRefs(AF2_SHA) },
  { match: /api\.github\.com\/repos\/deepmind\/alphafold$/, file: "github-alphafold.json" },
];

export function testDeps(over: Partial<Deps> = {}): Deps {
  return { root: VERIFY_DIR, mailto: "", log: () => {}, ...over };
}

export async function connect(deps: Deps) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call };
}

export const text = (r: CallToolResult, i = 0) => (r.content[i] as { type: "text"; text: string }).text;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const data = (r: CallToolResult) => r.structuredContent as any;
