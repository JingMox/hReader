// 这层管：路由表与精确匹配（按 `/` 分段逐段比较、无正则、无回溯）；不解析请求体、不写响应。

export type HttpMethod = "GET" | "POST";

/** `token` = 允许 `?t=` / `?token=` 的入口（`/` 与 `/s/<docId>`）；`cookie+csrf` = 写命令。 */
export type AuthKind = "none" | "cookie" | "token" | "cookie+csrf";

export type RouteKind =
  | "home"
  | "assets"
  | "theme"
  | "themes"
  | "healthz"
  | "document"
  | "docInfo"
  | "model"
  | "outline"
  | "patch"
  | "style"
  | "annotation"
  | "annotations"
  | "annotationAdd"
  | "annotationResolve"
  | "annotationDiff"
  | "undo"
  | "docTrust"
  | "docPermissions"
  | "permissionsGet"
  | "permissionsSet"
  | "docNormalize"
  | "events";

const DOC_PARAM = ":docId";

/** 批注 id（`an-<8 hex>`）：只占一段，不匹配任何带 `/` 的值。 */
const AN_PARAM = ":anId";

/** 吞掉剩余全部段（`/assets/<path>`，允许子目录）；空段与越界由 `handlers.assetReply` 再判。 */
const REST_PARAM = ":path";

/** `%2F` 解码后可以带 `/`，所以只有 `DOC_PARAM` 与 `REST_PARAM` 两个占位符，不做正则。 */

export interface Route {
  readonly method: HttpMethod;
  /** 字面段原样比较；`DOC_PARAM` 占一个段（其中的 `%2F` 解码后可以是子路径）。 */
  readonly segments: readonly string[];
  readonly auth: AuthKind;
  readonly kind: RouteKind;
}

type RouteLookup =
  | {
      readonly kind: "route";
      readonly route: Route;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: "method"; readonly allowed: readonly HttpMethod[] }
  | { readonly kind: "none" };

const route = (
  method: HttpMethod,
  segments: readonly string[],
  auth: AuthKind,
  kind: RouteKind,
): Route => Object.freeze({ method, segments: Object.freeze(segments), auth, kind });

export const ROUTES: readonly Route[] = Object.freeze([
  // `/` 也吃 token：`hr serve` 打印的就是 `/?token=…`，首访落 cookie 后 302 回干净的 `/`。
  route("GET", [], "token", "home"),
  route("GET", ["assets", REST_PARAM], "none", "assets"),
  route("GET", ["api", "theme"], "none", "themes"),
  route("GET", ["api", "theme", ":styleId"], "none", "theme"),
  route("GET", ["healthz"], "none", "healthz"),
  route("GET", ["s", DOC_PARAM], "token", "document"),
  route("GET", ["api", "doc", DOC_PARAM, "info"], "cookie", "docInfo"),
  route("GET", ["api", "doc", DOC_PARAM, "model"], "cookie", "model"),
  route("GET", ["api", "doc", DOC_PARAM, "outline"], "cookie", "outline"),
  route("POST", ["api", "patch"], "cookie+csrf", "patch"),
  route("POST", ["api", "style"], "cookie+csrf", "style"),
  route("POST", ["api", "annotation"], "cookie+csrf", "annotation"),
  route("GET", ["api", "doc", DOC_PARAM, "annotations"], "cookie", "annotations"),
  route("POST", ["api", "doc", DOC_PARAM, "annotations"], "cookie+csrf", "annotationAdd"),
  route(
    "POST",
    ["api", "doc", DOC_PARAM, "annotations", AN_PARAM, "resolve"],
    "cookie+csrf",
    "annotationResolve",
  ),
  route("GET", ["api", "doc", DOC_PARAM, "notes", AN_PARAM, "diff"], "cookie", "annotationDiff"),
  route("POST", ["api", "doc", DOC_PARAM, "undo"], "cookie+csrf", "undo"),
  route("POST", ["api", "doc", DOC_PARAM, "trust"], "cookie+csrf", "docTrust"),
  route("POST", ["api", "doc", DOC_PARAM, "permissions"], "cookie+csrf", "docPermissions"),
  route("GET", ["api", "permissions"], "cookie", "permissionsGet"),
  route("POST", ["api", "permissions"], "cookie+csrf", "permissionsSet"),
  route("POST", ["api", "doc", DOC_PARAM, "normalize"], "cookie+csrf", "docNormalize"),
  route("GET", ["api", "events"], "cookie", "events"),
]);

/** 空段（`//`、尾斜杠）直接判不匹配：路由表里没有"宽松"写法，避免 `%2f` 与 `/` 两套口径。 */
const segmentsOf = (pathname: string): readonly string[] | undefined => {
  if (!pathname.startsWith("/")) return undefined;
  if (pathname === "/") return [];
  const segments = pathname.slice(1).split("/");
  return segments.some((segment) => segment.length === 0) ? undefined : segments;
};

const paramsOf = (
  candidate: Route,
  segments: readonly string[],
): Record<string, string> | undefined => {
  const pattern = candidate.segments;
  const restAt = pattern.indexOf(REST_PARAM);
  if (restAt === -1 ? pattern.length !== segments.length : segments.length <= restAt) {
    return undefined;
  }
  const params: Record<string, string> = {};
  // 按 pattern 遍历、按位置从段里"取一个"：`slice+join` 不产生未定义值与死分支，
  // 少段时的 `""` 一定被下面的 `wanted !== actual` 判成不匹配（空段在更早的守卫里已被拒）。
  for (const [index, wanted] of pattern.entries()) {
    const actual = segments.slice(index, index + 1).join("");
    if (wanted === REST_PARAM) {
      params["path"] = segments.slice(index).join("/");
      return params;
    }
    if (wanted.startsWith(":")) params[wanted.slice(1)] = actual;
    else if (wanted !== actual) return undefined;
  }
  return params;
};

export const matchRoute = (method: string, pathname: string): RouteLookup => {
  const segments = segmentsOf(pathname);
  if (segments === undefined) return { kind: "none" };
  // RFC 9110 §9.1：method token 区分大小写——`get` 不是 `GET`，不许静默大写放行。
  const allowed: HttpMethod[] = [];
  for (const candidate of ROUTES) {
    const params = paramsOf(candidate, segments);
    if (params === undefined) continue;
    if (candidate.method === method) return { kind: "route", route: candidate, params };
    allowed.push(candidate.method);
  }
  return allowed.length === 0
    ? { kind: "none" }
    : { kind: "method", allowed: Object.freeze(allowed) };
};

/**
 * 具名参数取值：命中就返回，缺失才用 `fallback`。
 * 写成循环而不是 `params[key] ?? fallback`，是因为后者在"路由保证一定有这个参数"的地方
 * 会留下一条**永远取不到**的默认值臂；循环的两条臂共享同一行，都是真实路径。
 */
export const paramOf = (
  params: Readonly<Record<string, string>>,
  key: string,
  fallback: string,
): string => {
  for (const [name, value] of Object.entries(params)) if (name === key) return value;
  return fallback;
};

type DecodedParams =
  { readonly ok: true; readonly params: Readonly<Record<string, string>> } | { readonly ok: false };

/** `%2e%2e%2f` 这类越界只能解码后再判：解码失败（坏 `%`）同样按 `invalid_request` 处理。 */
export const decodeParams = (params: Readonly<Record<string, string>>): DecodedParams => {
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    try {
      decoded[key] = decodeURIComponent(value);
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, params: Object.freeze(decoded) };
};
