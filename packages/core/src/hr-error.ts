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
  | "undo_unavailable";

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
