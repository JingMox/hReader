// 这层管：冻结错误码 → HTTP 状态码的唯一映射；不生成报文、不判鉴权。

import type { HrErrorCode } from "../hr-error";

/** 服务端**会抛**的码；`anchor_lost` 是客户端的"锚点失效"reason，服务端永不抛（裁定 #14）。 */
export type ServerCode = Exclude<HrErrorCode, "anchor_lost">;

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
};

export const statusOf = (code: ServerCode): number => STATUS[code];
