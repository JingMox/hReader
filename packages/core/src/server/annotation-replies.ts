// 这层管：M2.3 的四个批注/撤销处理器（AC3.1–AC3.4）；只产出 `Reply`/`Written`，不碰 socket。

import { z } from "zod";

import type { ResolvedTarget } from "../io/paths";
import { diffText, resolveAnchor, type Annotation, type TextAnchor } from "../annotations";
import { HrError } from "../hr-error";
import { jsonObject } from "../schema";
import type { DocumentModel } from "../model/constants";
import { addAnnotation, listAnnotations, resolveAnnotation } from "../ops/annotationOps";
import { revertLast } from "../ops/revertOp";
import { blockBasisOf, flattenOf, modelOf } from "./annotation-basis";
import { integer, optionalString, parseBody, requiredString } from "./body";
import type { AnnotationDiffBody, Reply } from "./contracts";
import { busy, jsonReply, targetOf, type HandlerContext, type Written } from "./handlers";
import { revisionOf } from "./revision";

const bytesOf = (ctx: HandlerContext, target: ResolvedTarget): Promise<Uint8Array> =>
  ctx.deps.fs.readFile(target.realPath);

/** 锚点解析的"文档侧"：失败是值不是异常（AC1.2），且**按批注自己的块**判（裁定 #4）。 */
const lostOf = (model: DocumentModel, annotations: readonly Annotation[]): readonly string[] => {
  const nodes = flattenOf(model);
  const ids = nodes.map((node) => node.id);
  return annotations
    .filter((annotation) => {
      // 块没了 → `text` 为空（`join` 的自然结果），`resolveAnchor` 会用 `nodeIds` 判 `orphaned`；
      // 块在就只拿**这一块**的文本匹配，同句在别的块出现不能把它救活。
      const text = nodes
        .filter((node) => node.id === annotation.nodeId)
        .map((node) => node.text)
        .join("");
      return !resolveAnchor(annotation, { text, nodeIds: ids }).ok;
    })
    .map((annotation) => annotation.id);
};

export const annotationsReply = async (ctx: HandlerContext, docId: string): Promise<Reply> => {
  const target = await targetOf(ctx, docId);
  const bytes = await bytesOf(ctx, target);
  const listed = await listAnnotations({ workspace: ctx.workspace, file: docId }, ctx.deps);
  return jsonReply(200, {
    revision: revisionOf(bytes),
    annotations: listed.annotations,
    lost: lostOf(modelOf(bytes, target.realPath), listed.annotations),
    diagnostics: listed.diagnostics,
  });
};

const anchorBody = z.object({
  exact: requiredString,
  prefix: z.string().catch(""),
  suffix: z.string().catch(""),
  start: integer,
});

const addBody = z.object({ nodeId: requiredString, note: optionalString });

/** 缺 `anchor` 是 payload 形状错（`invalid_payload`），`anchor` 里的字段错才是请求错。 */
const anchorOf = (raw: unknown): TextAnchor => {
  if (!jsonObject.safeParse(raw).success) throw new HrError("invalid_payload", "anchor 缺失");
  return parseBody(anchorBody, raw);
};

export const annotationAddReply = async (
  ctx: HandlerContext,
  docId: string,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const target = await targetOf(ctx, docId);
  const { nodeId, note } = parseBody(addBody, body);
  const anchor = anchorOf(body["anchor"]);
  const result = await busy(() =>
    addAnnotation(
      { workspace: ctx.workspace, file: docId, nodeId, anchor, note: note ?? "" },
      ctx.deps,
      { lockTimeoutMs: lockMs },
    ),
  );
  return {
    reply: jsonReply(201, { id: result.annotation.id, revision: result.revision }),
    target,
    revision: result.revision,
    changed: true,
    changedNodes: [],
  };
};

/** 一个路由段 + 一个 body 就够：`anId` 与 `docId` 打包，免得 5 个位置参数（max-params: 4）。 */
export interface DocAnId {
  readonly docId: string;
  readonly anId: string;
}

const resolveBody = z.object({ resolutionNote: optionalString });

export const annotationResolveReply = async (
  ctx: HandlerContext,
  ids: DocAnId,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const target = await targetOf(ctx, ids.docId);
  const { resolutionNote } = parseBody(resolveBody, body);
  const result = await busy(() =>
    resolveAnnotation(
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
  return {
    reply: jsonReply(200, { revision: result.revision }),
    target,
    revision: result.revision,
    changed: true,
    changedNodes: [],
  };
};

export const undoReply = async (
  ctx: HandlerContext,
  docId: string,
  lockMs: number,
): Promise<Written> => {
  const target = await targetOf(ctx, docId);
  // 错误码映射（`undo_unavailable` → `nothing_to_undo`）只在 `revertLast` 里定义一份。
  await busy(() =>
    revertLast({ workspace: ctx.workspace, file: docId }, ctx.deps, { lockTimeoutMs: lockMs }),
  );
  const after = await bytesOf(ctx, target);
  return {
    reply: jsonReply(200, { revision: revisionOf(after) }),
    target,
    revision: revisionOf(after),
    changed: true,
    changedNodes: [],
  };
};

/** `GET /api/doc/<docId>/notes/<anId>/diff`：diff 在服务端算（裁定 #8），浏览器只渲染 chunk。 */
export const annotationDiffReply = async (ctx: HandlerContext, ids: DocAnId): Promise<Reply> => {
  const target = await targetOf(ctx, ids.docId);
  const bytes = await bytesOf(ctx, target);
  const listed = await listAnnotations({ workspace: ctx.workspace, file: ids.docId }, ctx.deps);
  const annotation = listed.annotations.find((item) => item.id === ids.anId);
  if (annotation === undefined) throw new HrError("not_found", `批注不存在：${ids.anId}`);
  // 裁定 #4：diff 的粒度是**这条批注自己的块**，不是全篇（全篇会让两条批注拿到同一份结果）。
  const model = modelOf(bytes, target.realPath);
  const basis = await blockBasisOf(ctx, target, model, annotation.nodeId);
  const diff = diffText(basis.before, basis.after);
  const body: AnnotationDiffBody = {
    revision: revisionOf(bytes),
    // 裁定：重识别后响应里的 `nodeId` 必须是当前文档里的真实 id（否则前端标不到块）。
    nodeId: basis.nodeId,
    before: basis.before,
    after: basis.after,
    chunks: diff.chunks,
    degraded: diff.degraded || basis.reason !== undefined,
    ...(basis.degradedReason === undefined ? {} : { degradedReason: basis.degradedReason }),
  };
  return jsonReply(200, body);
};
