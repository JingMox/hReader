// 这层管：构建产物与主题 CSS 的静态响应（路径白名单 + 缓存/CSP 头）；不解析请求体、不分发路由。

import { join } from "node:path";

import { HrError } from "../hr-error";
import { ARTICLE_TAG, type HtmlElementNode, type HtmlNode } from "../html/constants";
import { parseHtml } from "../html/parse";
import { serializeHtml } from "../html/serialize";
import { decodeUtf8 } from "../io/bytes";
import { isMissing } from "../io/errors";
import {
  builtinThemeDir,
  existsOf,
  listDirsOrEmpty,
  THEME_FILE,
  userStylesRoot,
  userThemePath,
} from "../style/resource";
import { loadThemeCss } from "../style/theme";
import type { Reply } from "./contracts";
import { documentReply, type HandlerContext } from "./handlers";
import { APP_CSP, assetSegmentsOf, contentTypeOf } from "./http-io";

const SECURITY = { "x-content-type-options": "nosniff" } as const;

/** 未构建时的默认主题名（服务器是唯一权威，客户端不许硬编码）。 */
const DEFAULT_THEME = "atelier-editorial";

/** `ENAMETOOLONG`/`EINVAL` 是"名字不合法"而非服务故障：按 404 处理。 */
const BAD_NAME = new Set(["ENAMETOOLONG", "EINVAL"]);

const codeOf = (error: unknown): unknown => Reflect.get(Object(error), "code");

const jsonReply = (status: number, value: unknown): Reply => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...SECURITY },
  body: JSON.stringify(value),
});

const STATIC_HEADERS = {
  ...SECURITY,
  "cache-control": "no-store",
} as const;

const notFound = (message: string): Reply => jsonReply(404, { code: "not_found", message });

const escapeHtml = (value: string): string =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");

/** 静态文件读不了就是 404（缺文件）或 500（真故障）：响应里不带绝对路径。 */
const fileOf = async (ctx: HandlerContext, path: string): Promise<Uint8Array | undefined> => {
  try {
    return await ctx.deps.fs.readFile(path);
  } catch (error: unknown) {
    const code = codeOf(error);
    if (isMissing(error) || (typeof code === "string" && BAD_NAME.has(code))) return undefined;
    throw new HrError("io_failure", "读取静态资源失败", { cause: error });
  }
};

/**
 * 未构建首页的响应头：**不用** `APP_CSP`（`script-src 'self'`）。首页服务端渲染了文档 raw-text，
 * 且不需要任何脚本；对齐文档页 `/s/<docId>` 的收紧口径（`default-src 'none'` + `no-referrer`），
 * 把可注入面压到最小（`style-src 'unsafe-inline'` 只为内联样式保底）。
 */
const HOME_FALLBACK_HEADERS = {
  ...STATIC_HEADERS,
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "referrer-policy": "no-referrer",
} as const;

/**
 * 没构建前端时的最小首页：**刻意回 200 而不是 503**。
 * 已冻结"带 cookie 访问 `/` 得 200 + docId 链接"的契约（`wire-http.test.ts`），
 * 本地 `hr serve` 也常被 `curl` 当自检入口；构建缺失是"开发者未跑 build"，不是服务故障。
 * `body` 是服务端渲染好的正文（见 `homeBodyOf`）：首页不许只是一个靠 JS 再拉一次的壳。
 */
const fallbackHome = (docId: string, body: string): Reply => ({
  status: 200,
  headers: HOME_FALLBACK_HEADERS,
  body: `<!doctype html><meta charset="utf-8"><title>hReader</title><h1>hReader</h1><p>当前文档：<a href="/s/${encodeURIComponent(docId)}">${escapeHtml(docId)}</a></p>${body}<p><a href="/healthz">healthz</a></p>`,
});

/** `GET /` 的 401 页：人读一句话说清怎么打开，而不是丢一句 JSON。 */
export const homeUnauthorizedReply = (): Reply => ({
  status: 401,
  headers: HOME_FALLBACK_HEADERS,
  body: `<!doctype html><meta charset="utf-8"><title>hReader</title><h1>hReader</h1><p>这个地址需要访问凭据：请用 <code>hr serve</code> 打印的地址打开（形如 <code>http://127.0.0.1:&lt;port&gt;/?token=…</code>）。</p>`,
});

const childNodesOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "document" || node.kind === "element" ? node.children : [];

const articleIn = (node: HtmlNode): HtmlElementNode | undefined => {
  if (node.kind === "element" && node.tag === ARTICLE_TAG) return node;
  for (const child of childNodesOf(node)) {
    const found = articleIn(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * 首页外壳里的正文：直接拿文档的 `<article>` 子树（与 `/s/<docId>` 同一份可读内容，不跑 JS）。
 * 文档读不到/没有 `<article>` 时回空串而不是 5xx：首页是 `hr serve` 的自检入口，
 * "构建缺失"与"文档没了"都不该把 `GET /` 变成错误页（冻结的 200 契约）。
 */
const homeBodyOf = async (ctx: HandlerContext, docId: string): Promise<string> => {
  try {
    const doc = await documentReply(ctx, docId);
    const article = articleIn(parseHtml(decodeUtf8(doc.bytes, docId)).root);
    if (article === undefined) return "";
    return serializeHtml({
      root: { kind: "document", children: [article] },
      diagnostics: [],
    });
  } catch {
    return "";
  }
};

/**
 * `GET /`：
 * - 未构建 → 200 最小首页 + 服务端渲染的正文（冻结契约，见 `fallbackHome`）；
 * - 已构建（`appDir` 非空）且没带 `?doc=` → **302** 到 `/?doc=<docId>`（不注入 HTML）；
 * - 带了 `?doc=` → 回 `index.html`。
 */
export const indexReply = async (
  ctx: HandlerContext,
  docId: string,
  hasDocQuery = true,
): Promise<Reply> => {
  if (ctx.appDir === "") return fallbackHome(docId, await homeBodyOf(ctx, docId));
  if (!hasDocQuery) {
    return {
      status: 302,
      headers: { location: `/?doc=${encodeURIComponent(docId)}`, "cache-control": "no-store" },
      body: "",
    };
  }
  const bytes = await fileOf(ctx, join(ctx.appDir, "index.html"));
  if (bytes === undefined) return notFound("应用未构建：缺少 index.html");
  return {
    status: 200,
    headers: {
      ...STATIC_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": APP_CSP,
    },
    body: bytes,
  };
};

/** 越界一律 404（不暴露"那里有东西"），未知文件同样 404。
 *  `appDir === ""`（未构建）时先拒：`join("", "assets", …)` 会落到 `<cwd>/assets`，把本地同名文件服务出去。 */
export const assetReply = async (ctx: HandlerContext, rawPath: string): Promise<Reply> => {
  if (ctx.appDir === "") return notFound("应用未构建");
  const segments = assetSegmentsOf(rawPath);
  if (segments === undefined) return notFound("资源路径不合法");
  const path = join(ctx.appDir, "assets", ...segments);
  const bytes = await fileOf(ctx, path);
  if (bytes === undefined) return notFound("资源不存在");
  return {
    status: 200,
    headers: { ...STATIC_HEADERS, "content-type": contentTypeOf(path) },
    body: bytes,
  };
};

/** 内置 + 用户主题清单：客户端不再硬编码主题名。 */
export const themesReply = async (ctx: HandlerContext): Promise<Reply> => {
  const deps = ctx.styleDeps;
  const builtin = await listDirsOrEmpty(deps.stylesRoot, deps);
  const users = await listDirsOrEmpty(userStylesRoot(deps), deps);
  const ids: string[] = [];
  for (const id of [...builtin, ...users]) {
    if (ids.includes(id)) continue;
    // 两边形状不同：`builtinThemeDir` 是目录、`userThemePath` 已是文件；统一成"要探测的文件"。
    const path = builtin.includes(id)
      ? join(builtinThemeDir(id, deps), THEME_FILE)
      : userThemePath(id, deps);
    if (await existsOf(path, deps)) ids.push(id);
  }
  return jsonReply(200, {
    themes: ids.length === 0 ? [DEFAULT_THEME] : ids,
    default: DEFAULT_THEME,
  });
};

/** 主题 CSS 只从内置/用户主题目录读；未知 id 让 `unknown_style` 冒泡成 404。 */
export const themeReply = async (ctx: HandlerContext, styleId: string): Promise<Reply> => {
  const css = await loadThemeCss(styleId, ctx.styleDeps);
  return {
    status: 200,
    headers: { ...STATIC_HEADERS, "content-type": "text/css; charset=utf-8" },
    body: css,
  };
};
