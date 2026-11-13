// 这层管：路由表与精确匹配（按 `/` 分段逐段比较、无正则、无回溯）；不解析请求体、不写响应。

export type HttpMethod = "GET" | "POST";

/** `token` = 唯一允许 `?t=` 的入口（`/s/<docId>`）；`cookie+csrf` = 写命令。 */
export type AuthKind = "none" | "cookie" | "token" | "cookie+csrf";

export type RouteKind =
  | "home"
  | "healthz"
  | "document"
  | "model"
  | "outline"
  | "patch"
  | "style"
  | "annotation"
  | "events";

const DOC_PARAM = ":docId";

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
  route("GET", [], "cookie", "home"),
  route("GET", ["healthz"], "none", "healthz"),
  route("GET", ["s", DOC_PARAM], "token", "document"),
  route("GET", ["api", "doc", DOC_PARAM, "model"], "cookie", "model"),
  route("GET", ["api", "doc", DOC_PARAM, "outline"], "cookie", "outline"),
  route("POST", ["api", "patch"], "cookie+csrf", "patch"),
  route("POST", ["api", "style"], "cookie+csrf", "style"),
  route("POST", ["api", "annotation"], "cookie+csrf", "annotation"),
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
  if (candidate.segments.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, pattern] of candidate.segments.entries()) {
    const segment = segments.slice(index, index + 1).join("");
    if (pattern === DOC_PARAM) {
      params["docId"] = segment;
      continue;
    }
    if (pattern !== segment) return undefined;
  }
  return params;
};

export const matchRoute = (method: string, pathname: string): RouteLookup => {
  const segments = segmentsOf(pathname);
  if (segments === undefined) return { kind: "none" };
  const upper = method.toUpperCase();
  const allowed: HttpMethod[] = [];
  for (const candidate of ROUTES) {
    const params = paramsOf(candidate, segments);
    if (params === undefined) continue;
    if (candidate.method === upper) return { kind: "route", route: candidate, params };
    allowed.push(candidate.method);
  }
  return allowed.length === 0
    ? { kind: "none" }
    : { kind: "method", allowed: Object.freeze(allowed) };
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
