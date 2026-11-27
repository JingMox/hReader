// This layer serves sibling assets of a document under `GET /f/<cap>/<path>`:
// cap lookup, the in-directory scope verdict, and the typed asset reply.
// It never resolves docIds and never touches the write side.

import { extname, join, relative, sep } from "node:path";

import { isInside } from "../io/paths";
import type { FileStat } from "../io/ports";
import { ANNOTATOR_NAME } from "./annotate";
import type { Reply } from "./contracts";
import { documentServeOf, type AnnotateRequest, type HandlerContext } from "./handlers";

/**
 * D9's extension whitelist — the only resource kinds a page may pull from its
 * own directory. `.html`/`.htm` are absent on purpose (another document must
 * never be readable as a resource); the served document itself is exempted via
 * `grant.docName` before this map is consulted.
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
  // Same stamp the document reply carries: asset responses must never help a
  // cross-origin page learn the frame URL via Referer leakage.
  "referrer-policy": "no-referrer",
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
 * `/f/<cap>/__hr_annotator.js` is a reserved name: it wins over a real file of
 * the same name in the doc directory (the injected tag trusts only the
 * server's own copy; the document owns whatever sits in its tree). Bytes come
 * from `<appDir>/annotator.js`; same verdict as every other failure on this
 * route — unreadable means 404, with no existence distinction.
 */
const annotatorReply = async (ctx: HandlerContext): Promise<Reply> => {
  if (ctx.appDir === "") return notFound();
  let bytes: Uint8Array;
  try {
    bytes = await ctx.deps.fs.readFile(join(ctx.appDir, "annotator.js"));
  } catch {
    return notFound();
  }
  return {
    status: 200,
    headers: { ...BASE_HEADERS, "content-type": "text/javascript; charset=utf-8" },
    body: bytes,
  };
};

/**
 * `/f/` path grammar: no empty segment (so `//` and a trailing slash die), no
 * dot-leading segment at all — one rule covers `.`, `..`, `.hreader/` and every
 * dotfile — no NUL and no backslash, bounded length. `..` can therefore never
 * appear in the accepted form; the traversal verdict is lexical, before any IO.
 */
const segmentsOf = (rawPath: string): readonly string[] | undefined => {
  if (rawPath.length > MAX_PATH_LEN) return undefined;
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
  annotate?: string,
): Promise<Reply> => {
  const grant = ctx.caps.lookup(cap);
  if (grant === undefined) return notFound();
  // The reserved name first: it must win over a real file of the same name in
  // the doc directory (and it can never equal an .html docName).
  if (rawPath === ANNOTATOR_NAME) return annotatorReply(ctx);
  // The one HTML exception: the document this cap was minted for, by exact
  // basename. It keeps the permission-matrix headers (CSP + sandbox), plus
  // this route's CORS. `annotate` is only consulted on this branch — every
  // other asset path ignores the parameter entirely.
  if (rawPath === grant.docName) {
    // Stryker disable ConditionalExpression: fabricating a request while
    // annotate is absent only hands consume an undefined token — the book has
    // no such entry, the fallback is identical, equivalent.
    const request: AnnotateRequest | undefined =
      annotate === undefined
        ? undefined
        : { cap: grant.cap, docName: grant.docName, token: annotate };
    // Stryker restore ConditionalExpression
    return withCors((await documentServeOf(ctx, grant.doc, request)).reply);
  }
  const segments = segmentsOf(rawPath);
  // Stryker disable next-line ConditionalExpression: when segments===undefined the
  // `...segments` spread on the next line must throw TypeError, and it lands inside
  // the realpath try — the catch returns the same 404, equivalent.
  if (segments === undefined || typeOf(rawPath) === undefined) return notFound();
  let real: string;
  try {
    real = await ctx.deps.fs.realpath(join(grant.dir, ...segments));
  } catch {
    // Missing, dangling or looping symlinks and name errors all land here:
    // an unresolvable path can never prove it is in scope.
    return notFound();
  }
  // Stryker disable next-line ConditionalExpression: an out-of-scope real makes
  // relative() produce a `..`-prefixed rel, and the segmentsOf(rel) grammar
  // re-verdict below answers the same 404 — this gate is strictly synonymous
  // with the re-check; it guards readability, not a new rule.
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
  // stat.size precheck: an over-ceiling file is refused before a single byte
  // lands in memory. 404 rather than 413 — same oracle argument as every
  // other rejection here.
  if (!stat.isFile() || stat.size > MAX_DOC_ASSET_BYTES) return notFound();
  let bytes: Uint8Array;
  try {
    bytes = await ctx.deps.fs.readFile(real);
  } catch {
    return notFound();
  }
  // The file may have grown between lstat and readFile — recheck the bytes.
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
