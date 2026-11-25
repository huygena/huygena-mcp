import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** A tool failure with a stable code. The server turns it into an MCP tool error the model can read. */
export class ToolError extends Error {
  override name = "ToolError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Largest manifest, results, certificate or bundle.json file read from disk. */
export const MAX_DOC_BYTES = 5 * 1024 * 1024;

/** The root, or a clear error when the file tools are off. */
export function requireRoot(root: string | null): string {
  if (root === null) {
    throw new ToolError(
      "no_root",
      "File access is off: the server was started in the filesystem root and HUYGENA_MCP_ROOT is not set. Set HUYGENA_MCP_ROOT to the folder that holds your manifests and evidence, or pass documents inline.",
    );
  }
  return root;
}

/**
 * Resolve `path` (relative to `root`, or absolute) and make sure the real path,
 * after following symlinks, stays inside `root`. `root` must already be a real path.
 */
export async function resolveInRoot(rootOrNull: string | null, path: string): Promise<{ abs: string; rel: string }> {
  const root = requireRoot(rootOrNull);
  const p = path.trim();
  if (!p) throw new ToolError("invalid_path", "path is empty");
  if (p.includes("\0")) throw new ToolError("invalid_path", "path contains a NUL byte");
  const candidate = resolve(root, p);
  let abs: string;
  try {
    abs = await realpath(candidate);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Do not confirm whether something exists outside the root.
    if (!inside(root, candidate)) throw outside(path, root);
    if (code === "ENOENT") throw new ToolError("not_found", `${JSON.stringify(path)} does not exist under ${root}`);
    throw new ToolError("io_error", `cannot read ${JSON.stringify(path)}: ${(e as Error).message}`);
  }
  if (!inside(root, abs)) throw outside(path, root);
  return { abs, rel: relative(root, abs).split(sep).join("/") || "." };
}

function inside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function outside(path: string, root: string): ToolError {
  return new ToolError(
    "outside_root",
    `${JSON.stringify(path)} is outside the folder this server may read (${root}). Set HUYGENA_MCP_ROOT to a folder that contains it.`,
  );
}

/** A directory under the root, for hashing. */
export async function dirInRoot(root: string | null, path: string): Promise<{ abs: string; rel: string }> {
  const r = await resolveInRoot(root, path);
  const st = await stat(r.abs);
  if (!st.isDirectory()) throw new ToolError("not_a_directory", `${JSON.stringify(path)} is not a directory`);
  return r;
}

/** A regular file under the root, read as UTF-8 text. */
export async function readTextInRoot(root: string | null, path: string): Promise<string> {
  const r = await resolveInRoot(root, path);
  const st = await stat(r.abs);
  if (!st.isFile()) throw new ToolError("not_a_file", `${JSON.stringify(path)} is not a file`);
  if (st.size > MAX_DOC_BYTES) throw new ToolError("too_large", `${JSON.stringify(path)} is ${st.size} bytes; the limit is ${MAX_DOC_BYTES}`);
  return readFile(r.abs, "utf8");
}

/**
 * Document arguments accept inline text or a file path. A value is a path when it is
 * one line, does not start with `{` or `[`, and ends in .yaml, .yml or .json.
 */
export function looksLikePath(value: string): boolean {
  const v = value.trim();
  return !/[\r\n]/.test(v) && !/^[{[]/.test(v) && /\.(ya?ml|json)$/i.test(v);
}

/** Inline document text, or the contents of the file it names (under the root). */
export async function docText(root: string | null, value: string): Promise<{ text: string; file: string | null }> {
  if (looksLikePath(value)) return { text: await readTextInRoot(root, value), file: value.trim() };
  return { text: value, file: null };
}
