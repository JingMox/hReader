// This layer: error-text normalization (first line, unknown -> string) and the "report first, then fail" error shapes; zero I/O.

import { HrError } from "@hreader/core";

/**
 * `--strict` failure: the report is already staged in `report` (stdout goes first as usual), and the error
 * itself maps to exit 1 as `invalid_document`. Under `--json` the report JSON must be the only stdout line,
 * so the error message always goes to stderr — not through `reportFailure`'s "json errors go to stdout" channel.
 */
export class StrictFailure extends HrError {
  readonly report: string;

  constructor(message: string, report: string) {
    super("invalid_document", message);
    this.name = "StrictFailure";
    this.report = report;
  }
}

/**
 * Wrapper that "appends one stderr guidance line" to an existing error: code / message / data are preserved
 * verbatim (frozen contract untouched); `reportFailure` prints the hint after the error line.
 */
export class HintedError extends HrError {
  readonly hint: string;

  constructor(error: HrError, hint: string) {
    super(error.code, error.message, {
      cause: error,
      ...(error.data === undefined ? {} : { data: error.data }),
    });
    this.name = "HintedError";
    this.hint = hint;
  }
}

/**
 * Keep only the first non-empty line, truncated to 200 chars: Chrome / puppeteer / pdf-lib errors often carry
 * whole stacks and absolute paths — stuffing them into the envelope both leaks paths and blows up `--json`.
 */
export const firstErrorLineOf = (text: string): string => {
  const line = text.split(/\r?\n/u).find((item) => item.trim() !== "") ?? "";
  return line.length > 200 ? line.slice(0, 200) : line;
};

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
