// This layer: the single `HrErrorCode` -> exit-code mapping (frozen table); no error interpretation, no printing.

import type { HrErrorCode } from "@hreader/core";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_IO = 3;
export const EXIT_INTERNAL = 70;

/** `satisfies` turns "new code without updating the table" into a type error: exhaustiveness is compiler-guaranteed, not self-checked. */
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
  daemon_already_running: EXIT_FAILURE,
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
  needs_normalize: EXIT_USAGE,
  port_in_use: EXIT_USAGE,
  content_model_conflict: EXIT_USAGE,
  // Duplicate ids are a "fixable by normalize --write" state, same tier as `needs_normalize`
  duplicate_id: EXIT_USAGE,
} satisfies Record<HrErrorCode, number>;

/** `satisfies` already guarantees exhaustiveness: CLI and core ship from the same repo and version — there is no "new core with old CLI" runtime branch. */
export const exitCodeOf = (code: HrErrorCode): number => EXIT_CODES[code];
