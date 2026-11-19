// 这层管：对外错误契约（稳定 code + instanceof 判定）；不管文案、本地化与 IO。
// code 联合类型随功能卡扩展，已分配的值不得改名或复用。

export type HrErrorCode =
  | "invalid_html"
  | "no_article"
  | "node_not_found"
  | "invalid_selector"
  | "invalid_document"
  | "node_not_allowed"
  | "invalid_max_bytes"
  | "invalid_input"
  | "locked"
  | "invalid_fragment"
  | "forbidden_content"
  | "path_outside_workspace"
  | "not_a_file"
  | "io_failure"
  | "invalid_utf8"
  | "undo_unavailable"
  | "invalid_style"
  | "unknown_style"
  | "invalid_theme"
  | "style_io_failure"
  | "not_found"
  | "invalid_request"
  | "busy"
  | "too_many_clients"
  | "unauthorized"
  | "forbidden_origin"
  | "daemon_already_running"
  // M2.3：批注 / 撤销（只三个新码，`not_found` 复用既有值）
  | "invalid_payload"
  | "nothing_to_undo"
  | "anchor_lost"
  // M4.1：风格提取（`llm_failure` 的 message 里不许出现 key、prompt 或响应体原文）
  | "llm_failure"
  | "file_exists"
  // M4.3：打印导出——`no_article` 指源文档里没有 `<article>`，本码指 `<article>` 在但裁完无文本，两者不许合并
  | "empty_document"
  // M4.4：真 Chrome 渲染——四个码共用 exit 3（进程/环境问题，不是用户输入问题）
  | "chrome_missing"
  | "chrome_failed"
  | "render_timeout"
  | "render_empty"
  // M4.8 C1/C4：文档缺 `data-hr-id` 是可一步修好的状态（`hr normalize --write`），不当用法错以外的错
  | "needs_normalize"
  // M4.8：端口被别的进程占——与 `daemon_already_running`（确实有 daemon 在跑）是两件事
  | "port_in_use"
  // R1-F6：片段内容模型与目标容器不兼容（用户换容器/改 HTML 就能修，故与 `invalid_input` 分开）
  | "content_model_conflict";

/**
 * 唯一对外错误类型。跨包用 `instanceof HrError` 判定，按 `code` 分支；
 * `message` 只给人看，程序判定必须依赖 `code`。
 */
export class HrError extends Error {
  readonly code: HrErrorCode;

  constructor(code: HrErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HrError";
    this.code = code;
  }
}
