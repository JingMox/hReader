// 这层管：侧车批注 HTTP 处理器——meta 与 sidecar 合并视图、五个写操作；
// 只产出 `Reply`/`Written`，不碰 socket。HTML 文件永远不碰：doc 侧车写只动 `.hreader/`，
// `changed:false` 不发 doc.changed，广播走独立的 `doc.annotations` 事件（runtime 分发）。

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
 * 线上的 relocation 形状：`ok` 时给 `start`/`end`/`via`（偏移永远落在 `bodyTextOf` 域里，
 * `via` 只说明命中的是哪一级回退）；失败时只给 `reason`——内部 `via` 不上线，
 * 调用方看到的就是"这条批注丢了锚点"这一事实。
 */
const relocationBody = (
  relocation: RelocateResult,
):
  | { readonly ok: true; readonly start: number; readonly end: number; readonly via: string }
  | { readonly ok: false; readonly reason: string } =>
  relocation.ok
    ? { ok: true, start: relocation.start, end: relocation.end, via: relocation.via }
    : { ok: false, reason: relocation.reason };

/** 合并条目拍平成一条：批注字段 + `source`（meta/sidecar）+ 服务端算好的 `relocation`。 */
const entryBody = (entry: DocAnnotationEntry): Record<string, unknown> => ({
  ...entry.annotation,
  source: entry.source,
  relocation: relocationBody(entry.anchor),
});

/** `GET /api/doc/<docId>/sidecar`：meta + sidecar 合并视图，各条带 relocation。 */
export const sidecarListReply = async (ctx: HandlerContext, docId: string): Promise<Reply> => {
  await targetOf(ctx, docId);
  const listed = await listDocAnnotations({ workspace: ctx.workspace, file: docId }, ctx.deps);
  return jsonReply(200, {
    annotations: listed.annotations.map(entryBody),
    diagnostics: listed.diagnostics,
  });
};

// ---- bodies：strict zod，未知键即拒；边界与 store 的上限同源 ----

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
 * 写操作回执与列表条目同形：刚写完的批注重算一遍 relocation，并附 `revision`
 * （`revisionOf` 口径不变——侧车写不改文档字节，它就是"当前文档版本"）。
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
    // 侧车写不动 HTML：changed:false——noteWrite 静默，广播由 doc.annotations 担。
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
