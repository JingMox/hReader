// 这层管：`HrErrorCode` → 退出码的唯一映射（AC2 冻结表）；不解释错误、不打印。

import type { HrErrorCode } from "@hreader/core";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_IO = 3;
export const EXIT_INTERNAL = 70;

/** `satisfies` 让"新增 code 却不改表"变成类型错误：穷尽性由编译器保证，不靠人自查。 */
const EXIT_CODES = {
  invalid_html: EXIT_FAILURE,
  no_article: EXIT_FAILURE,
  node_not_found: EXIT_FAILURE,
  invalid_selector: EXIT_FAILURE,
  invalid_document: EXIT_FAILURE,
  node_not_allowed: EXIT_FAILURE,
  invalid_max_bytes: EXIT_FAILURE,
  invalid_input: EXIT_FAILURE,
  locked: EXIT_FAILURE,
  invalid_fragment: EXIT_FAILURE,
  forbidden_content: EXIT_FAILURE,
  undo_unavailable: EXIT_FAILURE,
  invalid_style: EXIT_FAILURE,
  unknown_style: EXIT_FAILURE,
  invalid_theme: EXIT_FAILURE,
  path_outside_workspace: EXIT_IO,
  not_a_file: EXIT_IO,
  io_failure: EXIT_IO,
  style_io_failure: EXIT_IO,
  invalid_utf8: EXIT_IO,
  not_found: EXIT_FAILURE,
  invalid_request: EXIT_FAILURE,
  busy: EXIT_FAILURE,
  too_many_clients: EXIT_FAILURE,
  unauthorized: EXIT_FAILURE,
  forbidden_origin: EXIT_FAILURE,
  daemon_already_running: EXIT_USAGE,
  invalid_payload: EXIT_FAILURE,
  nothing_to_undo: EXIT_FAILURE,
  anchor_lost: EXIT_FAILURE,
  llm_failure: EXIT_IO,
  file_exists: EXIT_FAILURE,
  empty_document: EXIT_FAILURE,
  chrome_missing: EXIT_IO,
  chrome_failed: EXIT_IO,
  render_timeout: EXIT_IO,
  render_empty: EXIT_IO,
} satisfies Record<HrErrorCode, number>;

/** `satisfies` 已保证表内穷尽：CLI 与 core 同仓同版本，不存在"新 core 配旧 CLI"的运行时分支。 */
export const exitCodeOf = (code: HrErrorCode): number => EXIT_CODES[code];
