// 这层管：构建产物与主题 CSS 的静态响应（路径白名单 + 缓存/CSP 头）；不解析请求体、不分发路由。

import { join } from "node:path";

import { HrError } from "../hr-error";
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
import type { HandlerContext } from "./handlers";
import { APP_CSP, assetSegmentsOf, contentTypeOf } from "./http-io";

const SECURITY = { "x-content-type-options": "nosniff" } as const;

/** 未构建时的默认主题名（服务器是唯一权威，客户端不许硬编码——裁定 #2/#3）。 */
const DEFAULT_THEME = "atelier-editorial";

/** `ENAMETOOLONG`/`EINVAL` 是"名字不合法"而非服务故障：按 404 处理（裁定 #9）。 */
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

const HOME_FALLBACK_HEADERS = {
  ...STATIC_HEADERS,
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": APP_CSP,
} as const;

/**
 * 没构建前端时的最小首页：**刻意回 200 而不是 503**。
 * M2.1 已冻结"带 cookie 访问 `/` 得 200 + docId 链接"的契约（`wire-http.test.ts`），
 * 本地 `hr serve` 也常被 `curl` 当自检入口；构建缺失是"开发者未跑 build"，不是服务故障。
 */
const fallbackHome = (docId: string): Reply => ({
  status: 200,
  headers: HOME_FALLBACK_HEADERS,
  body: `<!doctype html><meta charset="utf-8"><title>hReader</title><h1>hReader</h1><p>当前文档：<a href="/s/${encodeURIComponent(docId)}">${escapeHtml(docId)}</a></p><p><a href="/api/healthz">healthz</a></p>`,
});

/**
 * `GET /`：
 * - 已构建（`appDir` 非空）且没带 `?doc=` → **302** 到 `/?doc=<docId>`（不注入 HTML，裁定 #1）；
 * - 带了 `?doc=` → 回 `index.html`；
 * - 未构建 → 200 最小首页（M2.1 冻结契约，见 `fallbackHome`）。
 */
export const indexReply = async (
  ctx: HandlerContext,
  docId: string,
  hasDocQuery = true,
): Promise<Reply> => {
  if (ctx.appDir === "") return fallbackHome(docId);
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

/** AC1.2/AC1.3：越界一律 404（不暴露"那里有东西"），未知文件同样 404。 */
export const assetReply = async (ctx: HandlerContext, rawPath: string): Promise<Reply> => {
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

/** 内置 + 用户主题清单（裁定 #2）：客户端不再硬编码主题名。 */
export const themesReply = async (ctx: HandlerContext): Promise<Reply> => {
  const deps = ctx.styleDeps;
  const builtin = await listDirsOrEmpty(deps.stylesRoot, deps);
  const users = await listDirsOrEmpty(userStylesRoot(deps), deps);
  const ids: string[] = [];
  for (const id of [...builtin, ...users]) {
    if (ids.includes(id)) continue;
    const path = builtin.includes(id) ? builtinThemeDir(id, deps) : userThemePath(id, deps);
    if (await existsOf(`${path}/${THEME_FILE}`, deps)) ids.push(id);
  }
  return jsonReply(200, {
    themes: ids.length === 0 ? [DEFAULT_THEME] : ids,
    default: DEFAULT_THEME,
  });
};

/** AC5.2：主题 CSS 只从内置/用户主题目录读；未知 id 让 `unknown_style` 冒泡成 404。 */
export const themeReply = async (ctx: HandlerContext, styleId: string): Promise<Reply> => {
  const css = await loadThemeCss(styleId, ctx.styleDeps);
  return {
    status: 200,
    headers: { ...STATIC_HEADERS, "content-type": "text/css; charset=utf-8" },
    body: css,
  };
};
