// This layer owns the sidecar-annotation HTTP handlers — the merged meta+sidecar
// view and the five write ops. They produce `Reply`/`Written` only, never a socket.
// The HTML file is never touched: a doc sidecar write only touches `.hreader/`,
// `changed:false` keeps doc.changed silent, and broadcasting rides the dedicated
// `doc.annotations` event (dispatched in runtime).

import { z } from "zod";

import {
  ANCHOR_LIMITS,
  docRelocatorOf,
  NOTE_LIMIT,
  SELECTOR_LIMITS,
  type RelocateResult,
  type SidecarAnnotation,
} from "../annotations";
import { decodeUtf8 } from "../io/bytes";
import type { ResolvedTarget } from "../io/paths";
import {
  addSidecarAnnotation,
  deleteSidecarAnnotation,
  listDocAnnotations,
  reopenSidecarAnnotation,
  replySidecarAnnotation,
  resolveSidecarAnnotation,
  type DocAnnotationEntry,
} from "../ops/sidecar-ops";
import { integer, parseBody } from "./body";
import type { DocAnId } from "./annotation-replies";
import type { Reply } from "./contracts";
import { busy, jsonReply, targetOf, type HandlerContext, type Written } from "./handlers";
import { revisionOf } from "./revision";

const bytesOf = (ctx: HandlerContext, target: ResolvedTarget): Promise<Uint8Array> =>
  ctx.deps.fs.readFile(target.realPath);

/**
 * The wire relocation shape: `ok` yields `start`/`end`/`via` (offsets always land in
 * the `bodyTextOf` domain; `via` only says which fallback level hit); failure yields
 * `reason` alone — the internal `via` never goes on the wire, so the caller sees the
 * plain fact "this annotation lost its anchor".
 */
const relocationBody = (
  relocation: RelocateResult,
):
  | { readonly ok: true; readonly start: number; readonly end: number; readonly via: string }
  | { readonly ok: false; readonly reason: string } =>
  relocation.ok
    ? { ok: true, start: relocation.start, end: relocation.end, via: relocation.via }
    : { ok: false, reason: relocation.reason };

/** A merged entry flattens to one record: annotation fields + `source` (meta/sidecar) + the server-computed `relocation`. */
const entryBody = (entry: DocAnnotationEntry): Record<string, unknown> => ({
  ...entry.annotation,
  source: entry.source,
  relocation: relocationBody(entry.anchor),
});

/** `GET /api/doc/<docId>/sidecar`: the merged meta + sidecar view, each entry carrying its relocation. */
export const sidecarListReply = async (ctx: HandlerContext, docId: string): Promise<Reply> => {
  await targetOf(ctx, docId);
  const listed = await listDocAnnotations({ workspace: ctx.workspace, file: docId }, ctx.deps);
  return jsonReply(200, {
    annotations: listed.annotations.map(entryBody),
    diagnostics: listed.diagnostics,
  });
};

// ---- bodies: strict zod — unknown keys die; bounds come from the store's own limits ----

const sidecarAnchorBody = z
  .object({
    exact: z.string().min(1).max(ANCHOR_LIMITS.exact),
    prefix: z.string().max(ANCHOR_LIMITS.prefix),
    suffix: z.string().max(ANCHOR_LIMITS.suffix),
    start: integer.nonnegative().safe(),
  })
  .strict();

const sidecarAddBody = z
  .object({
    docId: z.string().optional(),
    anchor: sidecarAnchorBody,
    selector: z.string().min(1).max(SELECTOR_LIMITS.chars).optional(),
    note: z.string().max(NOTE_LIMIT),
  })
  .strict();

const sidecarResolveBody = z
  .object({ docId: z.string().optional(), resolutionNote: z.string().max(NOTE_LIMIT).optional() })
  .strict();

const sidecarReplyBody = z
  .object({ docId: z.string().optional(), note: z.string().max(NOTE_LIMIT) })
  .strict();

const sidecarEmptyBody = z.object({ docId: z.string().optional() }).strict();

/**
 * Write receipts share the list-entry shape: recompute the just-written annotation's
 * relocation and attach `revision` (`revisionOf` semantics unchanged — a sidecar
 * write does not change document bytes, so it still reads as "the current version").
 */
const writtenOf = async (
  ctx: HandlerContext,
  target: ResolvedTarget,
  annotation: SidecarAnnotation,
  status: number,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<Written> => {
  const bytes = await bytesOf(ctx, target);
  const relocation = docRelocatorOf(decodeUtf8(bytes, target.realPath))(annotation);
  return {
    reply: jsonReply(status, {
      ...annotation,
      source: "sidecar",
      relocation: relocationBody(relocation),
      revision: revisionOf(bytes),
      ...extra,
    }),
    target,
    revision: revisionOf(bytes),
    // Sidecar writes never touch the HTML: changed:false keeps noteWrite silent — broadcasting is doc.annotations' job.
    changed: false,
    changedNodes: [],
  };
};

export const sidecarAddReply = async (
  ctx: HandlerContext,
  docId: string,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const input = parseBody(sidecarAddBody, body);
  const target = await targetOf(ctx, docId);
  const result = await busy(() =>
    addSidecarAnnotation(
      {
        workspace: ctx.workspace,
        file: docId,
        anchor: input.anchor,
        ...(input.selector === undefined ? {} : { selector: input.selector }),
        note: input.note,
        author: "user",
      },
      ctx.deps,
      { lockTimeoutMs: lockMs },
    ),
  );
  return writtenOf(ctx, target, result.annotation, 201);
};

export const sidecarResolveReply = async (
  ctx: HandlerContext,
  ids: DocAnId,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const { resolutionNote } = parseBody(sidecarResolveBody, body);
  const target = await targetOf(ctx, ids.docId);
  const result = await busy(() =>
    resolveSidecarAnnotation(
      {
        workspace: ctx.workspace,
        file: ids.docId,
        id: ids.anId,
        ...(resolutionNote === undefined ? {} : { resolutionNote }),
      },
      ctx.deps,
      { lockTimeoutMs: lockMs },
    ),
  );
  return writtenOf(ctx, target, result.annotation, 200);
};

export const sidecarReopenReply = async (
  ctx: HandlerContext,
  ids: DocAnId,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  parseBody(sidecarEmptyBody, body);
  const target = await targetOf(ctx, ids.docId);
  const result = await busy(() =>
    reopenSidecarAnnotation({ workspace: ctx.workspace, file: ids.docId, id: ids.anId }, ctx.deps, {
      lockTimeoutMs: lockMs,
    }),
  );
  return writtenOf(ctx, target, result.annotation, 200);
};

export const sidecarReplyReply = async (
  ctx: HandlerContext,
  ids: DocAnId,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const { note } = parseBody(sidecarReplyBody, body);
  const target = await targetOf(ctx, ids.docId);
  const result = await busy(() =>
    replySidecarAnnotation(
      {
        workspace: ctx.workspace,
        file: ids.docId,
        id: ids.anId,
        note,
        author: "user",
      },
      ctx.deps,
      { lockTimeoutMs: lockMs },
    ),
  );
  return writtenOf(ctx, target, result.annotation, 200, { reply: result.reply });
};

export const sidecarDeleteReply = async (
  ctx: HandlerContext,
  ids: DocAnId,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  parseBody(sidecarEmptyBody, body);
  const target = await targetOf(ctx, ids.docId);
  const result = await busy(() =>
    deleteSidecarAnnotation({ workspace: ctx.workspace, file: ids.docId, id: ids.anId }, ctx.deps, {
      lockTimeoutMs: lockMs,
    }),
  );
  return writtenOf(ctx, target, result.annotation, 200);
};
