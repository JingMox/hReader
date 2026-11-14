// 这层管：把 HTTP 语义翻成 core 调用（校验 → 加锁 → 落盘），返回"状态码 + 头 + 体"；不碰 socket、不分发路由。

import { HrError } from "../hr-error";
import { decodeUtf8, encodeUtf8 } from "../io/bytes";
import { writeAtomic } from "../io/atomic";
import { nonce } from "../io/digest";
import { runLocked } from "../io/lock";
import type { ResolvedTarget } from "../io/paths";
import { resolveTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";
import { patchFile } from "../io/patchFile";
import { parseHtml } from "../html/parse";
import { toDocumentModel } from "../model/derive";
import type { DocumentModel } from "../model/constants";
import { buildOutline } from "../ops/outline";
import type { PatchAction, PatchRequest } from "../ops/patchNode";
import { applyStyle } from "../style/applyFile";
import type { StyleDeps } from "../style";
import { appendAnnotation, type AnnotationInput, type AnnotationOutcome } from "./annotation";
import type { Reply } from "./contracts";
import { diffNodes } from "./diff-nodes";
import { integerFieldOf, requiredStringOf, stringFieldOf } from "./body";
import { revisionOf } from "./revision";

export interface HandlerContext {
  readonly workspace: string;
  /** 构建产物目录（`index.html` + `assets/`），由 `ServerOptions.appDir` 传入。 */
  readonly appDir: string;
  readonly deps: PatchDeps;
  readonly styleDeps: StyleDeps;
}

interface DocumentServe {
  readonly reply: Reply;
  readonly target: ResolvedTarget;
  readonly bytes: Uint8Array;
  readonly revision: string;
}

export interface Written {
  readonly reply: Reply;
  readonly target: ResolvedTarget;
  readonly revision: string;
  readonly changed: boolean;
  readonly changedNodes: readonly string[];
}

/** 写锁等不到就回 409：HTTP 请求不能跟着别的请求无限期排队。 */
export const LOCK_WAIT_MS = 5_000;

const SECURITY = { "x-content-type-options": "nosniff" } as const;

const HTML_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY,
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const JSON_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY,
  "content-type": "application/json; charset=utf-8",
};

/** @internal 由 M2.3 处理器（annotation-replies.ts）复用；不进公共导出面。 */
export const jsonReply = (status: number, value: unknown): Reply => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(value),
});

const htmlReply = (body: Uint8Array | string): Reply => ({
  status: 200,
  headers: HTML_HEADERS,
  body,
});

export const healthzReply = (uptimeMs: number): Reply =>
  jsonReply(200, { ok: true, uptimeMs, pid: process.pid });

const modelOf = (bytes: Uint8Array, label: string): DocumentModel =>
  toDocumentModel(parseHtml(decodeUtf8(bytes, label)));

/** @internal 同上：批注处理器要按 docId 解析目标。 */
export const targetOf = (ctx: HandlerContext, docId: string): Promise<ResolvedTarget> =>
  resolveTarget({ workspace: ctx.workspace, file: docId }, ctx.deps.fs);

const bytesOf = (ctx: HandlerContext, target: ResolvedTarget): Promise<Uint8Array> =>
  ctx.deps.fs.readFile(target.realPath);

/** `locked` 是"另一个写请求在跑"的正常状态，对 HTTP 应表达为 409 而非 500。 */
/** @internal `locked` → 409 的翻译只该有一处。 */
export const busy = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof HrError && error.code === "locked") {
      throw new HrError("busy", "文档正被另一个写请求占用，请稍后重试", { cause: error });
    }
    throw error;
  }
};

const loadDocument = async (ctx: HandlerContext, docId: string): Promise<DocumentServe> => {
  const target = await targetOf(ctx, docId);
  const bytes = await bytesOf(ctx, target);
  return {
    reply: jsonReply(200, { revision: revisionOf(bytes) }),
    target,
    bytes,
    revision: revisionOf(bytes),
  };
};

export const modelReply = async (ctx: HandlerContext, docId: string): Promise<Reply> => {
  const doc = await loadDocument(ctx, docId);
  return jsonReply(200, { revision: doc.revision, model: modelOf(doc.bytes, doc.target.realPath) });
};

export const outlineReply = async (ctx: HandlerContext, docId: string): Promise<Reply> => {
  const doc = await loadDocument(ctx, docId);
  const outline = buildOutline(parseHtml(decodeUtf8(doc.bytes, doc.target.realPath)));
  return jsonReply(200, { revision: doc.revision, outline });
};

export const documentReply = async (ctx: HandlerContext, docId: string): Promise<DocumentServe> => {
  const doc = await loadDocument(ctx, docId);
  return { ...doc, reply: htmlReply(doc.bytes) };
};

const changedOf = (before: Uint8Array, after: Uint8Array, label: string): readonly string[] =>
  diffNodes(modelOf(before, label), modelOf(after, label));

const ACTIONS: Readonly<Record<string, PatchAction>> = {
  replace: "replace",
  insert_before: "insert_before",
  insert_after: "insert_after",
  append: "append",
  delete: "delete",
};

const actionOf = (record: Readonly<Record<string, unknown>>): PatchAction => {
  const action = requiredStringOf(record, "action");
  const known = ACTIONS[action];
  if (known === undefined) throw new HrError("invalid_request", `未知 action：${action}`);
  return known;
};

const requestOf = (record: Readonly<Record<string, unknown>>): PatchRequest => {
  const targetId = requiredStringOf(record, "targetId");
  const action = actionOf(record);
  const fragment = stringFieldOf(record, "fragment");
  return fragment === undefined ? { targetId, action } : { targetId, action, html: fragment };
};

export const patchReply = async (
  ctx: HandlerContext,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const docId = requiredStringOf(body, "docId");
  const target = await targetOf(ctx, docId);
  const before = await bytesOf(ctx, target);
  const result = await busy(() =>
    patchFile({ workspace: ctx.workspace, file: docId, request: requestOf(body) }, ctx.deps, {
      lockTimeoutMs: lockMs,
    }),
  );
  const after = await bytesOf(ctx, target);
  const changedNodes = changedOf(before, after, target.realPath);
  return {
    reply: jsonReply(200, {
      changed: result.changed,
      revision: revisionOf(after),
      undoable: result.undoable,
      changedNodes,
      newIds: result.newIds,
    }),
    target,
    revision: revisionOf(after),
    changed: result.changed,
    changedNodes,
  };
};

export const styleReply = async (
  ctx: HandlerContext,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const docId = requiredStringOf(body, "docId");
  const visualId = requiredStringOf(body, "visualId");
  const target = await targetOf(ctx, docId);
  const before = await bytesOf(ctx, target);
  const result = await busy(() =>
    applyStyle({ workspace: ctx.workspace, file: docId, visualId }, ctx.styleDeps, {
      lockTimeoutMs: lockMs,
    }),
  );
  const after = await bytesOf(ctx, target);
  const changedNodes = result.changed ? changedOf(before, after, target.realPath) : [];
  return {
    reply: jsonReply(200, { changed: result.changed, revision: revisionOf(after), changedNodes }),
    target,
    revision: revisionOf(after),
    changed: result.changed,
    changedNodes,
  };
};

const inputOf = (body: Readonly<Record<string, unknown>>): AnnotationInput => ({
  start: integerFieldOf(body, "start"),
  end: integerFieldOf(body, "end"),
  text: requiredStringOf(body, "text"),
  note: stringFieldOf(body, "note"),
  status: "pending",
});

/** 读-改-写必须整段在锁里：`appendAnnotation` 要读当前 `hr-meta` 再整篇重写，锁外读会丢并发写。 */
const appendWithLock = async (
  ctx: HandlerContext,
  target: ResolvedTarget,
  input: AnnotationInput,
  lockMs: number,
): Promise<AnnotationOutcome> =>
  busy(() =>
    runLocked(target, ctx.deps, { lockTimeoutMs: lockMs }, async () => {
      const html = decodeUtf8(await bytesOf(ctx, target), target.realPath);
      // 时间戳只从注入的时钟来（`annotationOps` 同源），否则同一次写入不可复现。
      const createdAt = ctx.deps.clock.now().toISOString();
      const outcome = appendAnnotation(html, input, `an_${nonce().slice(0, 8)}`, createdAt);
      if (outcome.changed) {
        await writeAtomic(
          { path: target.realPath, workspace: ctx.workspace, data: encodeUtf8(outcome.html) },
          ctx.deps,
        );
      }
      return outcome;
    }),
  );

export const annotationReply = async (
  ctx: HandlerContext,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const docId = requiredStringOf(body, "docId");
  const target = await targetOf(ctx, docId);
  const before = await bytesOf(ctx, target);
  const written = await appendWithLock(ctx, target, inputOf(body), lockMs);
  const after = await bytesOf(ctx, target);
  return {
    reply: jsonReply(201, {
      id: written.newId,
      changed: written.changed,
      revision: revisionOf(after),
    }),
    target,
    revision: revisionOf(after),
    changed: written.changed,
    changedNodes: changedOf(before, after, target.realPath),
  };
};
