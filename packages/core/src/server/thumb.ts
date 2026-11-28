// This layer: `GET /api/doc/<docId>/thumb` — target resolution, content hash,
// etag/304, and delegation. Rendering itself is the injected `ThumbRender`'s
// job (the CLI wires the Chrome export pipeline in); the four render-layer
// Chrome codes have no place in the HTTP status table (`ServerCode` excludes
// them deliberately), so this layer translates them into the JSON error body
// itself instead of letting `errorReply` blur them into a generic 500.

import { HrError, type HrErrorCode } from "../hr-error";
import { sha256Hex } from "../io/digest";
import type { Reply, ThumbRender } from "./contracts";
import { targetOf, type HandlerContext } from "./handlers";
import { jsonOf, publicMessageOf } from "./http-io";

/** The export pipeline's failures: launch/environment problems, never client input — always a 500 carrying the frozen code. */
const RENDER_CODES: ReadonlySet<HrErrorCode> = new Set([
  "chrome_missing",
  "chrome_failed",
  "render_timeout",
  "render_empty",
]);

const thumbHeaders = (etag: string): Readonly<Record<string, string>> => ({
  "x-content-type-options": "nosniff",
  "cache-control": "private, max-age=0, must-revalidate",
  etag,
});

/** `If-None-Match` may list several tags or `*`; `W/` marks a weak tag — same hash still means unchanged. */
const etagMatches = (header: string | undefined, etag: string): boolean =>
  header
    ?.split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "*" || entry === etag || entry === `W/${etag}`) === true;

/**
 * The renderer's own failure surface: only the four pipeline codes translate
 * into the export-shaped body here — everything else (resolveTarget's 403/404,
 * io/utf8 failures) keeps riding `errorReply`'s status table via rethrow.
 */
const renderErrorReply = (error: unknown): Reply | undefined =>
  error instanceof HrError && RENDER_CODES.has(error.code)
    ? jsonOf(500, { code: error.code, message: publicMessageOf(error.message) })
    : undefined;

export const thumbReply = async (
  ctx: HandlerContext,
  docId: string,
  ifNoneMatch: string | undefined,
  render: ThumbRender | undefined,
): Promise<Reply> => {
  const target = await targetOf(ctx, docId);
  const bytes = await ctx.deps.fs.readFile(target.realPath);
  const hash = sha256Hex(bytes);
  const etag = `"${hash}"`;
  const headers = thumbHeaders(etag);
  if (etagMatches(ifNoneMatch, etag)) return { status: 304, headers, body: "" };
  if (render === undefined) {
    // Same code the export path reports when Chrome is missing: the status table
    // cannot carry it (ServerCode excludes the Chrome family), so the route
    // answers the JSON body itself rather than letting errorReply blur it into io_failure.
    return jsonOf(500, {
      code: "chrome_missing",
      message: "缩略图渲染器不可用（未注入渲染管线）",
    });
  }
  let png: Uint8Array;
  try {
    png = await render({ path: target.realPath, hash });
  } catch (error: unknown) {
    const reply = renderErrorReply(error);
    if (reply !== undefined) return reply;
    throw error;
  }
  return {
    status: 200,
    headers: { ...headers, "content-type": "image/png" },
    body: png,
  };
};
