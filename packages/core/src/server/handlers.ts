// 这层管：把 HTTP 语义翻成 core 调用（校验 → 加锁 → 落盘），返回"状态码 + 头 + 体"；不碰 socket、不分发路由。

import { z } from "zod";

import { HrError } from "../hr-error";
import { decodeUtf8, encodeUtf8 } from "../io/bytes";
import { writeAtomic } from "../io/atomic";
import { nonce } from "../io/digest";
import { runLocked } from "../io/lock";
import type { ResolvedTarget } from "../io/paths";
import { resolveTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";
import { patchFile } from "../io/patch-file";
import { readTrust, writeTrust, type TrustLevel } from "../io/trust";
import { parseHtml } from "../html/parse";
import { hasExecutableContent } from "../html/sanitize";
import { attributeOf } from "../model/attrs";
import { classifyDocument } from "../model/classify";
import { toDocumentModel } from "../model/derive";
import type { DocumentModel } from "../model/constants";
import type { HtmlElementNode } from "../html/constants";
import { isDocKind, KIND_ATTRIBUTE, type DocKind } from "../layout/kinds";
import { buildOutline } from "../ops/outline";
import { firstArticleOf } from "../ops/outline/locate";
import { normalizeFile } from "../ops/normalize-file";
import type { PatchAction, PatchRequest } from "../ops/patch-node";
import { applyStyle } from "../style/apply-file";
import type { StyleDeps } from "../style";
import { appendAnnotation, type AnnotationInput, type AnnotationOutcome } from "./annotation";
import type { Reply } from "./contracts";
import { diffNodes } from "./diff-nodes";
import { integer, optionalString, parseBody, requiredString } from "./body";
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

/**
 * 外来文档按信任档下发的 CSP。`sandbox` 指令是关键防线：即使有人在浏览器标签页里
 * 直接打开 `/s/<docId>`（顶层、不在 iframe 里），文档也被强制成 opaque origin——
 * 脚本读不到 cookie，也碰不到同源的写接口。**`sandbox` 后绝不能加 `allow-same-origin`**。
 * `local` 档的 `script-src 'unsafe-inline'` 能安全使用，正是因为 opaque origin +
 * `connect-src 'none'`：脚本跑得起来，但出不了源、也发不出请求。不要"修"它。
 */
const FOREIGN_CSP: Readonly<Record<TrustLevel, string>> = {
  off: "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  local:
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; " +
    "connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; " +
    "sandbox allow-scripts",
};

const JSON_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY,
  "content-type": "application/json; charset=utf-8",
};

/** @internal 由 annotation-replies.ts 的处理器复用；不进公共导出面。 */
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
  const parsed = parseHtml(decodeUtf8(doc.bytes, doc.target.realPath));
  // 冻结契约：非托管文档的 422/409 口径只在 derive 里有一份——让它抛，不复制文案。
  // （`remember` 不再为外来文档抛错，`buildOutline` 本身又不判 article。）
  if (classifyDocument(parsed).cls !== "managed") toDocumentModel(parsed);
  const outline = buildOutline(parsed);
  return jsonReply(200, { revision: doc.revision, outline });
};

export const documentReply = async (ctx: HandlerContext, docId: string): Promise<DocumentServe> => {
  const doc = await loadDocument(ctx, docId);
  const parsed = parseHtml(decodeUtf8(doc.bytes, doc.target.realPath));
  // 托管/可归一文档的响应头逐字节不动；外来文档才按信任档换 CSP。
  if (classifyDocument(parsed).cls !== "foreign") return { ...doc, reply: htmlReply(doc.bytes) };
  const trust = await readTrust({ target: doc.target, bytes: doc.bytes }, ctx.deps);
  return {
    ...doc,
    reply: {
      status: 200,
      headers: { ...HTML_HEADERS, "content-security-policy": FOREIGN_CSP[trust] },
      body: doc.bytes,
    },
  };
};

/** `kind` 只在恰好一个 `<article>` 时有意义：外来文档可能含多个 article，哪一个都不算"文档形态"。 */
const docKindOf = (article: HtmlElementNode | undefined): DocKind | undefined => {
  if (article === undefined) return undefined;
  const value = attributeOf(article, KIND_ATTRIBUTE);
  return value !== undefined && isDocKind(value) ? value : undefined;
};

/** 分档查询不判托管与否：外来文档也要能拿到 `cls`/`reason`，`model`/`outline` 的 422 契约不挪到这里。 */
export const docInfoReply = async (ctx: HandlerContext, docId: string): Promise<Reply> => {
  const target = await targetOf(ctx, docId);
  const bytes = await bytesOf(ctx, target);
  const parsed = parseHtml(decodeUtf8(bytes, target.realPath));
  const classification = classifyDocument(parsed);
  const kind = docKindOf(classification.articles === 1 ? firstArticleOf(parsed.root) : undefined);
  // 信任档只对外来文档有意义：managed/normalizable 永不执行文档脚本，恒报 "off"，
  // 也免得"先当外来授权、后被改成托管"的陈旧记录漏出来。
  const trust =
    classification.cls === "foreign" ? await readTrust({ target, bytes }, ctx.deps) : "off";
  return jsonReply(200, {
    revision: revisionOf(bytes),
    cls: classification.cls,
    trust,
    scripts: hasExecutableContent(parsed.root),
    ...(classification.reason === undefined ? {} : { reason: classification.reason }),
    ...(kind === undefined ? {} : { kind }),
  });
};

/**
 * 一切内容写先派生再放行：`modelOf(before)` 在写调用之前执行——外来/不可派生文档
 * 到不了 `writeAtomic`，不留"报失败却已改盘"的半成品（sha 键信任档会当场失效）。
 * undo/resolve 不挂这道闸：它们只恢复/改写服务端自产的快照与 hr-meta，不注入新内容，
 * 且 undo 是外部改坏文档后的唯一恢复路径。
 */
const diffOf = (beforeModel: DocumentModel, after: Uint8Array, label: string): readonly string[] =>
  diffNodes(beforeModel, modelOf(after, label));

/** 标注成 `ZodType<PatchAction>`：枚举里混进 `PatchAction` 之外的值会在编译期报错。 */
const patchAction: z.ZodType<PatchAction, z.ZodTypeDef, unknown> = z.enum([
  "replace",
  "insert_before",
  "insert_after",
  "append",
  "delete",
]);

const patchBody = z.object({
  docId: requiredString,
  targetId: requiredString,
  // 先判"给没给"再判"认不认识"：空串报缺字段，而不是"未知 action："。
  action: requiredString.pipe(patchAction),
  fragment: optionalString,
});

export const patchReply = async (
  ctx: HandlerContext,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const { docId, targetId, action, fragment } = parseBody(patchBody, body);
  const request: PatchRequest =
    fragment === undefined ? { targetId, action } : { targetId, action, html: fragment };
  const target = await targetOf(ctx, docId);
  const before = await bytesOf(ctx, target);
  const beforeModel = modelOf(before, target.realPath);
  const result = await busy(() =>
    patchFile({ workspace: ctx.workspace, file: docId, request }, ctx.deps, {
      lockTimeoutMs: lockMs,
    }),
  );
  const after = await bytesOf(ctx, target);
  const changedNodes = diffOf(beforeModel, after, target.realPath);
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

const styleBody = z.object({ docId: requiredString, visualId: requiredString });

export const styleReply = async (
  ctx: HandlerContext,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const { docId, visualId } = parseBody(styleBody, body);
  const target = await targetOf(ctx, docId);
  const before = await bytesOf(ctx, target);
  const beforeModel = modelOf(before, target.realPath);
  const result = await busy(() =>
    applyStyle({ workspace: ctx.workspace, file: docId, visualId }, ctx.styleDeps, {
      lockTimeoutMs: lockMs,
    }),
  );
  const after = await bytesOf(ctx, target);
  const changedNodes = result.changed ? diffOf(beforeModel, after, target.realPath) : [];
  return {
    reply: jsonReply(200, { changed: result.changed, revision: revisionOf(after), changedNodes }),
    target,
    revision: revisionOf(after),
    changed: result.changed,
    changedNodes,
  };
};

const annotationBody = z.object({
  docId: requiredString,
  start: integer,
  end: integer,
  text: requiredString,
  note: optionalString,
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
      // 时间戳只从注入的时钟来（`annotation-ops` 同源），否则同一次写入不可复现。
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
  const { docId, start, end, text, note } = parseBody(annotationBody, body);
  const target = await targetOf(ctx, docId);
  const before = await bytesOf(ctx, target);
  const beforeModel = modelOf(before, target.realPath);
  const written = await appendWithLock(
    ctx,
    target,
    { start, end, text, note, status: "pending" },
    lockMs,
  );
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
    changedNodes: diffOf(beforeModel, after, target.realPath),
  };
};

const trustBody = z.object({ level: z.enum(["off", "local"]) });

export const trustReply = async (
  ctx: HandlerContext,
  docId: string,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const { level } = parseBody(trustBody, body);
  const target = await targetOf(ctx, docId);
  const bytes = await bytesOf(ctx, target);
  const parsed = parseHtml(decodeUtf8(bytes, target.realPath));
  const classification = classifyDocument(parsed);
  if (classification.cls !== "foreign") {
    // 409 码表里没有"文档分档与操作不符"的专码：`needs_normalize` 是唯一
    // "文档状态不适用此操作"的 409 语义（其余 409 全是锁/快照/端口类）。
    // managed/normalizable 都不执行文档脚本，信任档对它们没有适用对象。
    throw new HrError(
      "needs_normalize",
      `信任档只对外来文档开放：该文档归作 ${classification.cls}，不执行脚本`,
    );
  }
  await busy(() => writeTrust({ target, bytes, level }, ctx.deps, { lockTimeoutMs: lockMs }));
  return {
    reply: jsonReply(200, { trust: level }),
    target,
    revision: revisionOf(bytes),
    // 文档字节没变，但下发头变了：阅读器必须重载 iframe，`changed` 就是"推 doc.changed"的扳机。
    changed: true,
    changedNodes: [],
  };
};

export const normalizeReply = async (
  ctx: HandlerContext,
  docId: string,
  lockMs: number,
): Promise<Written> => {
  const target = await targetOf(ctx, docId);
  const before = await bytesOf(ctx, target);
  const parsed = parseHtml(decodeUtf8(before, target.realPath));
  const classification = classifyDocument(parsed);
  if (classification.cls === "foreign") {
    throw new HrError(
      "invalid_document",
      classification.articles === 0
        ? // 与 ops/normalize-file.ts 同一份文案：`hr normalize` 与 HTTP 路由报同一句。
          "文档里没有 <article>：这不是可规范化的文档"
        : `文档里有 ${String(classification.articles)} 个 <article>：这不是可规范化的文档`,
    );
  }
  if (classification.cls === "managed") {
    // no-op：托管文档已带合法 id，不锁也不写，只回当前 revision。
    return {
      reply: jsonReply(200, { revision: revisionOf(before), cls: "managed" }),
      target,
      revision: revisionOf(before),
      changed: false,
      changedNodes: [],
    };
  }
  const result = await busy(() =>
    normalizeFile({ workspace: ctx.workspace, file: docId, write: true, history: true }, ctx.deps, {
      lockTimeoutMs: lockMs,
    }),
  );
  const after = await bytesOf(ctx, target);
  return {
    reply: jsonReply(200, { revision: revisionOf(after), cls: "managed" }),
    target,
    revision: revisionOf(after),
    changed: result.changed,
    // 写前是 normalizable（没有模型），写后是 managed：diff 无从算起，阅读器整页重拉即可。
    changedNodes: [],
  };
};
