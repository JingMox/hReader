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
  // 批注 / 撤销（只三个新码，`not_found` 复用既有值）
  | "invalid_payload"
  | "nothing_to_undo"
  | "anchor_lost"
  // 风格提取（`llm_failure` 的 message 里不许出现 key、prompt 或响应体原文）
  | "llm_failure"
  | "file_exists"
  // 打印导出——`no_article` 指源文档里没有 `<article>`，本码指 `<article>` 在但裁完无文本，两者不许合并
  | "empty_document"
  // 真 Chrome 渲染——四个码共用 exit 3（进程/环境问题，不是用户输入问题）
  | "chrome_missing"
  | "chrome_failed"
  | "render_timeout"
  | "render_empty"
  // 文档缺 `data-hr-id` 是可一步修好的状态（`hr normalize --write`），不当用法错以外的错
  | "needs_normalize"
  // 端口被别的进程占——与 `daemon_already_running`（确实有 daemon 在跑）是两件事
  | "port_in_use"
  // 片段内容模型与目标容器不兼容（用户换容器/改 HTML 就能修，故与 `invalid_input` 分开）
  | "content_model_conflict"
  // 文档里两个元素共用同一个 data-hr-id（`normalize` 会把重复的那个改名，但读/写入口必须先拒绝歧义）
  | "duplicate_id"
  // Templates: `unknown_template` means no tier has this id, while `invalid_template` means it was found but is broken or out of bounds
  | "unknown_template"
  | "invalid_template"
  // Stale block address: the path did not land on a same-fingerprint block and no unique
  // same-fingerprint match exists in the document (edited, moved, deleted or duplicated).
  // Re-listing mints a fresh address, so it stays in the business-refusal tier at exit 1
  | "target_moved";

/**
 * `invalid_selector` 有两种成因（文法不合法 / 选择器命中多个可寻址元素），
 * 报文之外必须给程序一个稳定的判别面：让调用方去正则 `message` 太脆，而多开一个错误码
 * 会打破「码表已冻结」的约定。`reason` 就是这两种成因的判别面。
 */
export interface HrErrorData {
  readonly reason: "syntax" | "ambiguous";
  /** 这次歧义里**可选项的总数**（候选上限截断不影响它）。
   * 它不是“选择器命中了几个元素”——那个数在 `matches`；两种成因都自洽的是“可选项数”，
   * 多义命中时等于 `addressable`，截断时仍等于 `addressable` 而不是 `candidates.length`
   * （不变式 `candidates.length === Math.min(count, 5)`）；双解释时恒为 2（id 一个 + 选择器一个）。 */
  readonly count?: number;
  /** 选择器命中元素数（含不可寻址）；截断时与 `count` 不等。 */
  readonly matches?: number;
  /** 多义时候选 `data-hr-id`，文档序。 */
  readonly candidates?: readonly string[];
}

/**
 * 唯一对外错误类型。跨包用 `instanceof HrError` 判定，按 `code` 分支；
 * `message` 只给人看，程序判定必须依赖 `code`（需要细分时看 `data.reason`）。
 */
export class HrError extends Error {
  readonly code: HrErrorCode;
  readonly data: HrErrorData | undefined;

  constructor(
    code: HrErrorCode,
    message: string,
    options?: { cause?: unknown; data?: HrErrorData },
  ) {
    super(message, options);
    this.name = "HrError";
    this.code = code;
    this.data = options?.data;
  }
}
