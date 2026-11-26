// This layer: `hr normalize` (fill in data-hr-id, optionally write back in place) -> text/JSON; no argument parsing, no exit codes.

import { HrError, nodePatchDeps, normalizeFile } from "@hreader/core";

import { HintedError } from "../errors";
import { dataNormalize, humanNormalizeWritten, jsonOk } from "../output";

/** Next-step guidance for foreign documents: error code and message are a frozen contract — the only addition allowed is this stderr line. */
const FOREIGN_HINT = "提示：这份文件可以直接在 hReader 阅读器里以只读方式打开\n";

export interface NormalizeInput {
  /** Workspace-relative path (same convention as patch). */
  readonly path: string;
  readonly workspace: string;
  readonly write: boolean;
  readonly json: boolean;
  /** Path printed in the receipt (user's view): falls back to the result's real path when not given. */
  readonly displayPath?: string | undefined;
}

export const normalizeCommand = async (input: NormalizeInput): Promise<string> => {
  const result = await normalizeFile(
    { workspace: input.workspace, file: input.path, write: input.write },
    nodePatchDeps,
  ).catch((error: unknown) => {
    // stderr must stay empty under `--json`: the hint is only attached to the human channel.
    if (!input.json && error instanceof HrError && error.code === "invalid_document") {
      throw new HintedError(error, FOREIGN_HINT);
    }
    throw error;
  });
  if (input.json) return jsonOk(dataNormalize(result));
  // Without write-back, stdout is the normalized result itself (no extra newline): `hr normalize a.html > b.html` must be byte-for-byte usable.
  return input.write
    ? humanNormalizeWritten(result, input.displayPath ?? result.path)
    : result.html;
};
