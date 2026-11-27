// 这层管：冻结错误码 → HTTP 状态码的唯一映射；不生成报文、不判鉴权。

import type { HrErrorCode } from "../hr-error";

/** 服务端**会抛**的码；`anchor_lost` 是客户端的"锚点失效"reason，服务端永不抛。
 *  `llm_failure` / `file_exists` 只由 CLI 侧的风格提取抛出（提取不经 HTTP），同样不进本表；
 *  `empty_document` 同理只由 `hr export print` 在本地渲染层抛出；
 *  the four Chrome codes all belong to CLI-side local rendering (launch/timeout/empty output) — the HTTP layer never throws them;
 *  the two template codes are only thrown by CLI/MCP-side template operations — the HTTP layer has no template route.
 */
export type ServerCode = Exclude<
  HrErrorCode,
  | "anchor_lost"
  | "llm_failure"
  | "file_exists"
  | "empty_document"
  | "chrome_missing"
  | "chrome_failed"
  | "render_timeout"
  | "render_empty"
  | "unknown_template"
  | "invalid_template"
>;

/** 客户端专用的码：HTTP 层永不抛它们，也不会为它们分配状态码。 */
const CLIENT_ONLY_CODES: ReadonlySet<HrErrorCode> = new Set<HrErrorCode>([
  "anchor_lost",
  "llm_failure",
  "file_exists",
  "empty_document",
  "chrome_missing",
  "chrome_failed",
  "render_timeout",
  "render_empty",
  "unknown_template",
  "invalid_template",
]);

/** 类型守卫：`Set.has` 不缩窄联合类型，而 `statusOf` / 响应体都要缩窄后的码。 */
export const isServerCode = (code: HrErrorCode): code is ServerCode => !CLIENT_ONLY_CODES.has(code);

/** 4xx 只给"客户端能改对"的错；服务端自身故障一律 500，避免把基础设施问题伪装成输入问题。 */
const STATUS: Readonly<Record<ServerCode, number>> = {
  invalid_html: 400,
  no_article: 422,
  node_not_found: 404,
  invalid_selector: 400,
  invalid_document: 422,
  node_not_allowed: 400,
  invalid_max_bytes: 400,
  invalid_input: 400,
  content_model_conflict: 400,
  duplicate_id: 400,
  locked: 409,
  invalid_fragment: 400,
  forbidden_content: 400,
  path_outside_workspace: 403,
  not_a_file: 404,
  io_failure: 500,
  invalid_utf8: 500,
  undo_unavailable: 409,
  invalid_style: 400,
  unknown_style: 404,
  invalid_theme: 400,
  style_io_failure: 500,
  not_found: 404,
  invalid_request: 400,
  busy: 503,
  too_many_clients: 429,
  unauthorized: 401,
  forbidden_origin: 403,
  daemon_already_running: 409,
  invalid_payload: 400,
  nothing_to_undo: 409,
  // 文档缺 `data-hr-id` 与服务端口被占都是“可一步修好的状态”，不是请求本身写错了。
  needs_normalize: 409,
  port_in_use: 409,
  // A stale block address is likewise a "fixable in one step" state: re-list for a fresh address, then retry.
  target_moved: 409,
};

export const statusOf = (code: ServerCode): number => STATUS[code];
