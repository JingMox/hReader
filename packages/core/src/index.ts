// 这层管：`@hreader/core` 唯一公开入口（按 docs/02 §5.2 的极小导出面）；不承载实现。

export { HrError } from "./hr-error";
export type { HrErrorCode } from "./hr-error";
export { injectNodeIds, parseHtml, serializeHtml } from "./html";
// 其余结构类型（attrs/各叶子节点）收在 src/html/index.ts：消费方经 `HtmlNode` 联合自取，
// 入口重复导出只会让"极小导出面"名存实亡（审计 P1-2）。
export type {
  Diagnostic,
  DiagnosticCode,
  HtmlElementNode,
  HtmlNode,
  InjectedNodeIds,
  ParsedHtml,
} from "./html";
