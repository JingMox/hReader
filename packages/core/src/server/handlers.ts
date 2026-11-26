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
import {
  effectiveOf,
  levelOfScripts,
  patchDocGrant,
  readDocGrant,
  readGlobalModes,
  writeGlobalModes,
  type DocGrant,
  type EffectivePermissions,
  type GlobalModes,
  type TrustLevel,
} from "../io/permissions";
import { parseHtml } from "../html/parse";
import { stripPrefetchLinks } from "../html/prefetch";
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
import type { CapabilityBook } from "./capability";
import type { Reply } from "./contracts";
import { diffNodes } from "./diff-nodes";
import { integer, optionalString, parseBody, requiredString } from "./body";
import { revisionOf } from "./revision";

export interface HandlerContext {
  readonly workspace: string;
  /** 构建产物目录（`index.html` + `assets/`），由 `ServerOptions.appDir` 传入。 */
  readonly appDir: string;
  /** 用户级配置根（`~/.hreader` 的父目录）：全局权限模式写在它的 `.hreader/permissions.json`。 */
  readonly home: string;
  readonly deps: PatchDeps;
  readonly styleDeps: StyleDeps;
  /** Doc-directory capability book: issues and resolves the caps `/f/` is gated by. */
  readonly caps: CapabilityBook;
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
  // 预取提示不归 CSP 管：`<link rel=dns-prefetch>` 照发 DNS 探测，头层关掉浏览器自己的预取。
  "x-dns-prefetch-control": "off",
};

/**
 * 外来文档按生效权限（脚本 × 联网，2×2）下发的 CSP。`sandbox` 指令是关键防线：即使
 * 有人在浏览器标签页里直接打开 `/f/<cap>/<doc>`（顶层、不在 iframe 里），文档也被强制成
 * opaque origin——脚本读不到 cookie，也碰不到同源的写接口。**`sandbox` 后绝不能加
 * `allow-same-origin`**。
 *
 * 「联网」是一个全包开关：网络资源加载（CDN 脚本/样式/图片/字体/媒体）与页面主动请求
 * （fetch/XHR/WebSocket/EventSource）共用同一组 `http: https:` 放宽 + `ws: wss:`。
 * 联网档访问不到 hReader 本机 API 的论证，三层独立兜底，缺一不可：
 *  1. 凭据兜底：页面带着 opaque origin，浏览器不给它发 `Cookie`（沙箱源的
 *     cookie 是隔离的，本地 API 要的会话 cookie 永远不在请求里）；
 *  2. 服务自身的 host/origin/CSRF 门槛：就算凭据泄露，`x-hr-csrf` 头不存在
 *     时写接口照旧拒绝，读接口被 `originAllowed` 与 host 白名单再挡一道——
 *     `Origin: null` 只在 `/f/` 被放行，其余路由一律 403；
 *  3. `/f/` 自身也只按 cap 服务一个目录：cap 不出目录，页面就碰不到
 *     别的文档（cap 只对携带它的调用方可见，且无法伪造）。
 *
 * 本地资源（`/f/` 下的同目录文件）属于"本地"、不受联网开关约束，所以各档都带
 * `'self'`。sandbox 下的 `'self'` 论证：CSP 的 `'self'` 匹配的是**文档 URL 的源**
 * （`http://127.0.0.1:<port>`），不是 sandbox 产生的 opaque origin——后者只影响
 * DOM/cookie/storage 那一侧。因此 `img-src 'self'` 之类允许页面请求同源的
 * `/f/`、`/assets/`、`/api/theme` 与 `/healthz`（后三者本来就无需凭据，但页面的
 * `Origin: null` 在非 `/f/` 路由上仍被 origin 闸门 403），而绝不允许它读到
 * `/f/` 之外的东西：同源 HTTP 访问还需要 cookie（opaque 源拿不到）或 cap
 * （伪造不了）。`script-src` 与 `connect-src` 只在脚本开档加 `'self'`：脚本关时
 * 页面根本跑不了脚本与 fetch，给出这两个源只是徒增表面。
 * `form-action`、`base-uri`、`frame-src`、`frame-ancestors` 与联网无关，
 * 四种组合里都保持收紧（`<base>` 改写与 meta-CSP 覆写对 HTTP 头下发的 CSP 无效——
 * 后下发的更严策略只会叠加，不会替换）。
 */
// 外键 = 脚本、内键 = 联网；两维都只有 on/off，查表完备——漏一档是编译期错误，不是运行期回落。
const FOREIGN_CSP: Readonly<Record<"off" | "on", Readonly<Record<"off" | "on", string>>>> = {
  off: {
    off:
      "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; media-src 'self'; " +
      "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox",
    on:
      "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline' http: https:; " +
      "img-src 'self' http: https: data: blob:; media-src 'self' http: https: data: blob:; " +
      "font-src 'self' http: https: data:; connect-src http: https: ws: wss:; " +
      "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox",
  },
  on: {
    off:
      "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
      "font-src 'self' data:; connect-src 'self'; " +
      "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; " +
      "sandbox allow-scripts",
    on:
      "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https:; " +
      "style-src 'self' 'unsafe-inline' http: https:; img-src 'self' http: https: data: blob:; " +
      "media-src 'self' http: https: data: blob:; font-src 'self' http: https: data:; " +
      "connect-src 'self' http: https: ws: wss:; frame-src 'none'; form-action 'none'; " +
      "base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
  },
};

const foreignCspOf = (effective: EffectivePermissions): string =>
  FOREIGN_CSP[effective.scripts ? "on" : "off"][effective.network ? "on" : "off"];

/** 单文档授权 + 全局模式一次读齐；`info`/`/s/`/三个写处理器共用同一个出口。 */
const permissionsOf = async (
  ctx: HandlerContext,
  target: ResolvedTarget,
  bytes: Uint8Array,
): Promise<{
  readonly grant: DocGrant;
  readonly modes: GlobalModes;
  readonly effective: EffectivePermissions;
}> => {
  const [modes, grant] = await Promise.all([
    readGlobalModes(ctx.home, ctx.deps),
    readDocGrant({ target, bytes }, ctx.deps),
  ]);
  return { grant, modes, effective: effectiveOf(modes, grant) };
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

const loadDocument = async (
  ctx: HandlerContext,
  docId: string,
): Promise<Omit<DocumentServe, "reply">> => {
  const target = await targetOf(ctx, docId);
  const bytes = await bytesOf(ctx, target);
  return {
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
  // Stryker disable next-line ConditionalExpression,StringLiteral: 让 toDocumentModel 自己抛——cls 条件无论怎么改，非托管文档都在那里炸，managed 多调一次无副作用。
  if (classifyDocument(parsed).cls !== "managed") toDocumentModel(parsed);
  const outline = buildOutline(parsed);
  return jsonReply(200, { revision: doc.revision, outline });
};

/**
 * Serve one resolved document with the permission-matrix headers. `/f/` calls
 * this for the doc-itself exception; `/s/` used to (it now only redirects);
 * the unbuilt home page borrows it for the article excerpt.
 * @internal
 */
export const documentServeOf = async (
  ctx: HandlerContext,
  target: ResolvedTarget,
): Promise<DocumentServe> => {
  const bytes = await bytesOf(ctx, target);
  const doc = { target, bytes, revision: revisionOf(bytes) };
  const parsed = parseHtml(decodeUtf8(doc.bytes, doc.target.realPath));
  // 托管/可归一文档的响应头逐字节不动；外来文档才按生效权限换 CSP。
  if (classifyDocument(parsed).cls !== "foreign") return { ...doc, reply: htmlReply(doc.bytes) };
  const { effective } = await permissionsOf(ctx, doc.target, doc.bytes);
  // 联网关时把 `<link rel=dns-prefetch|preconnect|prefetch|prerender|modulepreload>` 从下发
  // 字节里摘掉：预取提示不受 CSP 约束，是绕过联网闸的残余通道。只改响应，不动文件。
  const body =
    // Stryker disable next-line ConditionalExpression: 联网开时原文下发，strip 是纯字符串变换。
    effective.network ? doc.bytes : stripPrefetchLinks(decodeUtf8(doc.bytes, doc.target.realPath));
  return {
    ...doc,
    reply: {
      status: 200,
      headers: { ...HTML_HEADERS, "content-security-policy": foreignCspOf(effective) },
      body,
    },
  };
};

export const documentReply = async (ctx: HandlerContext, docId: string): Promise<DocumentServe> =>
  documentServeOf(ctx, await targetOf(ctx, docId));

/**
 * `/s/<docId>` no longer serves bytes — it hands out the frame URL. The page
 * itself (and every sibling asset it references) is served by `/f/` under the
 * directory cap this call registers. Query is dropped on purpose: the assets
 * route sends `no-store`, so cache-busting tags have nothing left to defeat.
 */
export const documentRedirectOf = (ctx: HandlerContext, target: ResolvedTarget): Reply => ({
  status: 302,
  headers: {
    location: ctx.caps.frameUrlOf(target),
    "cache-control": "no-store",
  },
  body: "",
});

/** `kind` 只在恰好一个 `<article>` 时有意义：外来文档可能含多个 article，哪一个都不算"文档形态"。 */
const docKindOf = (article: HtmlElementNode | undefined): DocKind | undefined => {
  if (article === undefined) return undefined;
  const value = attributeOf(article, KIND_ATTRIBUTE);
  // Stryker disable next-line ConditionalExpression: isDocKind(undefined) 恒 false，短路与否同值。
  return value !== undefined && isDocKind(value) ? value : undefined;
};

/** 分档查询不判托管与否：外来文档也要能拿到 `cls`/`reason`，`model`/`outline` 的 422 契约不挪到这里。 */
export const docInfoReply = async (ctx: HandlerContext, docId: string): Promise<Reply> => {
  const target = await targetOf(ctx, docId);
  const bytes = await bytesOf(ctx, target);
  const parsed = parseHtml(decodeUtf8(bytes, target.realPath));
  const classification = classifyDocument(parsed);
  const kind = docKindOf(classification.articles === 1 ? firstArticleOf(parsed.root) : undefined);
  // 权限只对外来文档有意义：managed/normalizable 永不执行文档脚本，不读授权、不携
  // `permissions` 字段，也免得"先当外来授权、后被改成托管"的陈旧记录漏出来。
  const perms =
    // Stryker disable next-line ConditionalExpression: 非外来文档不读授权库，字段缺失是契约的一部分。
    classification.cls === "foreign" ? await permissionsOf(ctx, target, bytes) : undefined;
  return jsonReply(200, {
    revision: revisionOf(bytes),
    cls: classification.cls,
    // 冻结契约：`trust` 字段映射为"脚本是否生效"，老客户端语义不变。
    // Stryker disable next-line ConditionalExpression: perms===undefined 时 trust 恒 "off"，与分支同义。
    ...(perms === undefined
      ? { trust: "off" as TrustLevel }
      : { trust: levelOfScripts(perms.effective.scripts) }),
    scripts: hasExecutableContent(parsed.root),
    // Stryker disable next-line ConditionalExpression: { permissions: undefined } 被 JSON.stringify 丢键，与 {} 同输出。
    ...(perms === undefined ? {} : { permissions: permissionInfo(perms) }),
    // Stryker disable next-line ConditionalExpression: { reason: undefined } 被 JSON.stringify 丢键，与 {} 同输出。
    ...(classification.reason === undefined ? {} : { reason: classification.reason }),
    // Stryker disable next-line ConditionalExpression: 同上，{ kind: undefined } 序列化后消失。
    ...(kind === undefined ? {} : { kind }),
    // 阅读器 iframe 的直接入口（F1 多文件页面）：`/f/` 连页面带同目录资源一起服务。
    frameUrl: ctx.caps.frameUrlOf(target),
  });
};

/** `info`/`permissions` 响应里共用的一坨：生效值 + 出处 + 当前全局模式。 */
const permissionInfo = (perms: {
  readonly effective: EffectivePermissions;
  readonly modes: GlobalModes;
}): Readonly<Record<string, unknown>> => ({
  scripts: perms.effective.scripts,
  network: perms.effective.network,
  scriptsSource: perms.effective.scriptsSource,
  networkSource: perms.effective.networkSource,
  modes: { scripts: perms.modes.scripts, network: perms.modes.network },
});

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
    // Stryker disable next-line ConditionalExpression: html:undefined 与不设字段同义，下游 patchFile 判 undefined。
    fragment === undefined ? { targetId, action } : { targetId, action, html: fragment };
  const target = await targetOf(ctx, docId);
  const before = await bytesOf(ctx, target);
  const beforeModel = modelOf(before, target.realPath);
  const result = await busy(() =>
    // Stryker disable next-line ObjectLiteral: 空 options 只落默认锁超时，行为同值。
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
  const parsed = parseHtml(decodeUtf8(before, target.realPath));
  // 外来文档没有可派生模型，但换主题是确认的例外：`applyStyle` 只拼接
  // `<style id="hr-theme">` 区间。跳过派生与 diff，才不会先写盘再 422；
  // 内容写（patch/批注）依旧先派生再放行，零写盘拒绝。
  const foreign = classifyDocument(parsed).cls === "foreign";
  const beforeModel = foreign ? undefined : toDocumentModel(parsed);
  const result = await busy(() =>
    // Stryker disable next-line ObjectLiteral: 空 options 只落默认锁超时，行为同值。
    applyStyle({ workspace: ctx.workspace, file: docId, visualId }, ctx.styleDeps, {
      lockTimeoutMs: lockMs,
    }),
  );
  const after = await bytesOf(ctx, target);
  const changedNodes =
    // Stryker disable next-line ConditionalExpression: 主题挂载点在 <head>、不在内容模型里，diff 恒为空——beforeModel 短路与否同输出。
    beforeModel !== undefined && result.changed ? diffOf(beforeModel, after, target.realPath) : [];
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
    // Stryker disable next-line ObjectLiteral: 空 options 只落默认锁超时，行为同值。
    runLocked(target, ctx.deps, { lockTimeoutMs: lockMs }, async () => {
      const html = decodeUtf8(await bytesOf(ctx, target), target.realPath);
      // 时间戳只从注入的时钟来（`annotation-ops` 同源），否则同一次写入不可复现。
      const createdAt = ctx.deps.clock.now().toISOString();
      const outcome = appendAnnotation(html, input, `an_${nonce().slice(0, 8)}`, createdAt);
      // Stryker disable next-line ConditionalExpression: appendAnnotation 的 changed 恒真（追加必改字节）。
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
    // Stryker disable next-line StringLiteral: 空 status 经 normalizeStatus 回落 "pending"，记录同值。
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

/**
 * 对外来文档写授权都要先过同一道闸：托管/可归一文档不执行文档脚本，授权对它们没有
 * 适用对象；顺带把 target/bytes 读好给调用方。`trust` 与 `permissions` 两个写入口共用。
 */
const foreignDocOf = async (
  ctx: HandlerContext,
  docId: string,
): Promise<{ readonly target: ResolvedTarget; readonly bytes: Uint8Array }> => {
  const target = await targetOf(ctx, docId);
  const bytes = await bytesOf(ctx, target);
  const classification = classifyDocument(parseHtml(decodeUtf8(bytes, target.realPath)));
  if (classification.cls !== "foreign") {
    // 409 码表里没有"文档分档与操作不符"的专码：`needs_normalize` 是唯一
    // "文档状态不适用此操作"的 409 语义（其余 409 全是锁/快照/端口类）。
    throw new HrError(
      "needs_normalize",
      `权限授权只对外来文档开放：该文档归作 ${classification.cls}，不执行脚本`,
    );
  }
  return { target, bytes };
};

export const trustReply = async (
  ctx: HandlerContext,
  docId: string,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const { level } = parseBody(trustBody, body);
  const doc = await foreignDocOf(ctx, docId);
  // 旧式档位只映脚本这一维：local = 脚本开、off = 脚本关，联网保持原值——
  // 老客户端不知道联网维度，不能把已开的联网一并收回。合并必须在信任锁内做
  // （patchDocGrant）：锁外读改写会被别名 docId 的并发写丢档。
  await busy(() =>
    patchDocGrant(
      { target: doc.target, patch: { scripts: level === "local" }, bytes: doc.bytes },
      ctx.deps,
      { lockTimeoutMs: lockMs },
    ),
  );
  // 响应里的 trust 报"脚本是否生效"：全局 deny 时就算单文档开了，生效的仍是关。
  const { effective } = await permissionsOf(ctx, doc.target, doc.bytes);
  return {
    reply: jsonReply(200, { trust: levelOfScripts(effective.scripts) }),
    target: doc.target,
    revision: revisionOf(doc.bytes),
    // 文档字节没变，但下发头变了：阅读器必须重载 iframe，`changed` 就是"推 doc.changed"的扳机。
    changed: true,
    changedNodes: [],
  };
};

const docPermissionsBody = z
  .object({ scripts: z.boolean().optional(), network: z.boolean().optional() })
  .refine((v) => v.scripts !== undefined || v.network !== undefined, {
    message: "至少要给 scripts 或 network 其中一个",
  });

export const docPermissionsReply = async (
  ctx: HandlerContext,
  docId: string,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const patch = parseBody(docPermissionsBody, body);
  const doc = await foreignDocOf(ctx, docId);
  // The merge must happen under the trust lock: an alias docId spelling
  // bypasses the per-doc request queue, so a read-then-write here could only
  // see a stale record and the second writer would drop the other's dimension.
  await busy(() =>
    patchDocGrant({ target: doc.target, patch, bytes: doc.bytes }, ctx.deps, {
      lockTimeoutMs: lockMs,
    }),
  );
  const after = await permissionsOf(ctx, doc.target, doc.bytes);
  return {
    reply: jsonReply(200, { permissions: permissionInfo(after) }),
    target: doc.target,
    revision: revisionOf(doc.bytes),
    changed: true,
    changedNodes: [],
  };
};

const globalModesBody = z
  .object({
    scripts: z.enum(["allow", "deny", "per-doc"]).optional(),
    network: z.enum(["allow", "deny", "per-doc"]).optional(),
  })
  .refine((v) => v.scripts !== undefined || v.network !== undefined, {
    message: "至少要给 scripts 或 network 其中一个",
  });

export const globalModesReply = async (ctx: HandlerContext): Promise<Reply> =>
  jsonReply(200, { modes: await readGlobalModes(ctx.home, ctx.deps) });

/**
 * 全局模式写。只返回 `{reply, modes}`，让 runtime 决定怎么广播：`permissions.changed`
 * 事件不是文档写事件，不能走 doc.changed 的 changed/revision 契约。
 */
export const globalModesSetReply = async (
  ctx: HandlerContext,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<{ readonly reply: Reply; readonly modes: GlobalModes }> => {
  const patch = parseBody(globalModesBody, body);
  const modes = await busy(() =>
    writeGlobalModes({ home: ctx.home, modes: patch }, ctx.deps, { lockTimeoutMs: lockMs }),
  );
  return { reply: jsonReply(200, { modes }), modes };
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
  // Stryker disable next-line ConditionalExpression,StringLiteral,BlockStatement: 拆掉这道早退也只让 normalizeFile 在托管文档上空跑一轮——无写无快照，回执同形。
  if (classification.cls === "managed") {
    // no-op：托管文档已带合法 id，不锁也不写，只回当前 revision。
    return {
      reply: jsonReply(200, { revision: revisionOf(before), cls: "managed" }),
      target,
      revision: revisionOf(before),
      changed: false,
      // Stryker disable next-line ArrayDeclaration: changed 恒 false，不会推送 doc.changed——changedNodes 无出口。
      changedNodes: [],
    };
  }
  const result = await busy(() =>
    // Stryker disable next-line ObjectLiteral: 空 options 只落默认锁超时，行为同值。
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
