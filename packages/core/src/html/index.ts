// 这层管：HTML 子模块对外的门面（解析/序列化/注入 + 树与诊断类型）；不做校验、不碰 IO。

export { hasArticle } from "./article";
export { injectNodeIds } from "./inject";
export type { InjectedNodeIds } from "./inject";
export { parseHtml } from "./parse";
export { serializeHtml } from "./serialize";
export type {
  Diagnostic,
  DiagnosticCode,
  HtmlElementNode,
  HtmlNode,
  ParsedHtml,
} from "./constants";
