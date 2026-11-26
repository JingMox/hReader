// This layer serves sibling assets of a document under `GET /f/<cap>/<path>`:
// cap lookup, the in-directory scope verdict, and the typed asset reply.
// It never resolves docIds and never touches the write side.

import { extname, join, relative, sep } from "node:path";

import { isInside } from "../io/paths";
import type { FileStat } from "../io/ports";
import type { Reply } from "./contracts";
import { documentServeOf, type HandlerContext } from "./handlers";

/**
 * D9's extension whitelist — the only resource kinds a page may pull from its
 * own directory. `.html`/`.htm` are absent on purpose (another document must
 * never be readable as a resource); the served document itself is exempted via
 * `grant.docs` before this map is consulted.
 */
const TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

const MAX_PATH_LEN = 512;
const MAX_SEGMENT_LEN = 255;

/** Single-file ceiling (D9): a bigger payload is not an asset, it is a file dump. */
export const MAX_DOC_ASSET_BYTES = 50 * 1024 * 1024;

/**
 * `/f/` answers `Access-Control-Allow-Origin: null` — literally and only `null`,
 * never an echo. Sandboxed (opaque-origin) pages send `Origin: null` on the
 * CORS-mode subresource requests (fonts, module scripts, fetch); without this
 * header the browser confiscates the response even when the server said yes.
 */
const CORS = { "access-control-allow-origin": "null" } as const;

const JSON_HEADERS: Readonly<Record<string, string>> = {
  ...CORS,
  "x-content-type-options": "nosniff",
  "content-type": "application/json; charset=utf-8",
};

const BASE_HEADERS: Readonly<Record<string, string>> = {
  ...CORS,
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

/**
 * SVG executes script when navigated to directly (it is a document type, not a
 * dumb image). Inside <img> it is already inert, so the header only guards the
 * direct-open case.
 */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * Every failure on this route is the same 404: capability misses, bad grammar,
 * escapes, missing files and oversized files are indistinguishable — the
 * answer must not double as an existence oracle.
 */
const notFound = (): Reply => ({
  status: 404,
  headers: JSON_HEADERS,
  body: JSON.stringify({ code: "not_found" }),
});

const withCors = (reply: Reply): Reply => ({
  ...reply,
  headers: { ...reply.headers, ...CORS },
});

/**
 * `/f/` path grammar: no empty segment (so `//` and a trailing slash die), no
 * dot-leading segment at all — one rule covers `.`, `..`, `.hreader/` and every
 * dotfile — no NUL and no backslash, bounded length. `..` can therefore never
 * appear in the accepted form; the traversal verdict is lexical, before any IO.
 */
const segmentsOf = (rawPath: string): readonly string[] | undefined => {
  if (rawPath.length === 0 || rawPath.length > MAX_PATH_LEN) return undefined;
  if (rawPath.includes("\0") || rawPath.includes("\\")) return undefined;
  const segments = rawPath.split("/");
  const bad = segments.some(
    (part) => part === "" || part.length > MAX_SEGMENT_LEN || part.startsWith("."),
  );
  return bad ? undefined : segments;
};

const typeOf = (path: string): string | undefined => TYPES[extname(path).toLowerCase()];

export const docAssetReply = async (
  ctx: HandlerContext,
  cap: string,
  rawPath: string,
): Promise<Reply> => {
  const grant = ctx.caps.lookup(cap);
  if (grant === undefined) return notFound();
  // The one HTML exception: the document itself, by exact registered basename.
  // It keeps the permission-matrix headers (CSP + sandbox), plus this route's CORS.
  const doc = grant.docs.get(rawPath);
  if (doc !== undefined) return withCors((await documentServeOf(ctx, doc)).reply);
  const segments = segmentsOf(rawPath);
  if (segments === undefined || typeOf(rawPath) === undefined) return notFound();
  let real: string;
  try {
    real = await ctx.deps.fs.realpath(join(grant.dir, ...segments));
  } catch {
    // Missing, dangling or looping symlinks and name errors all land here:
    // an unresolvable path can never prove it is in scope.
    return notFound();
  }
  if (!isInside(grant.dir, real)) return notFound();
  // Re-run the verdict on the *resolved* name: a symlink may point at a name
  // that fails the grammar (dot segment) or the whitelist (.html).
  const rel = relative(grant.dir, real).split(sep).join("/");
  const type = segmentsOf(rel) === undefined ? undefined : typeOf(rel);
  if (type === undefined) return notFound();
  let stat: FileStat;
  try {
    stat = await ctx.deps.fs.lstat(real);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();
  let bytes: Uint8Array;
  try {
    bytes = await ctx.deps.fs.readFile(real);
  } catch {
    return notFound();
  }
  // 404 rather than 413: same oracle argument as every other rejection here.
  if (bytes.length > MAX_DOC_ASSET_BYTES) return notFound();
  return {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "content-type": type,
      ...(type === "image/svg+xml" ? { "content-security-policy": SVG_CSP } : {}),
    },
    body: bytes,
  };
};
