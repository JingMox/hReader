// This layer: `hr patch` (fragment already parsed -> core writes -> text/JSON); no argument checks, no stdin.
// The entry runs the same "document is normalized" preflight as `outline`/`read`: patch consumes `data-hr-id`,
// so a half-normalized document (id on the root, none below) must be stopped here — otherwise the user gets guessing-game `node_not_found` errors.
// `<nodeId|selector>` is interpreted by the same implementation as `read` (core's `locateTarget`): both commands must resolve the same input to the same id.

import {
  type PatchAction,
  type PatchRequest,
  nodePatchDeps,
  parseHtml,
  patchFile,
  patchTargetIdOf,
} from "@hreader/core";

import {
  assertIsDocument,
  assertNormalized,
  assertUniqueIds,
  withNormalizeAdvice,
} from "../document-normalize";
import { dataPatch, humanPatch, jsonOk } from "../output";

export interface PatchInput {
  readonly path: string;
  /** `data-hr-id` or selector (same resolver as `hr read`): resolution happens inside core's lock; this layer does not read the file first. */
  readonly nodeId: string;
  readonly action: PatchAction;
  /** Must be `undefined` for `delete`; for other actions it is the fetched fragment text. */
  readonly html: string | undefined;
  readonly workspace: string;
  readonly json: boolean;
  /** Path printed in the receipt (user's view): falls back to the result's real path when not given. */
  readonly displayPath?: string | undefined;
}

/**
 * Judgment and location both run inside core's lock against **the very bytes about to be written** (`request` is
 * passed as a function): if the command layer read the file outside the lock first, it would judge a snapshot the
 * document could have drifted from, and locate a node on a different tree.
 * The order stays "is a document -> duplicate ids -> missing ids -> locate": duplicate ids rank ahead of
 * `needs_normalize` — that one means "ids are missing", this one means "two elements share one id".
 */
const requestOf =
  (input: PatchInput) =>
  (html: string): PatchRequest => {
    const parsed = parseHtml(html);
    assertIsDocument(parsed, input.path);
    assertUniqueIds(parsed, input.path);
    assertNormalized(parsed, input.path);
    const targetId = patchTargetIdOf(parsed, input.nodeId);
    return input.html === undefined
      ? { targetId, action: input.action }
      : { targetId, action: input.action, html: input.html };
  };

export const patchCommand = async (input: PatchInput): Promise<string> => {
  try {
    const result = await patchFile(
      { workspace: input.workspace, file: input.path, request: requestOf(input) },
      nodePatchDeps,
    );
    return input.json
      ? jsonOk(dataPatch(result))
      : humanPatch(result, input.displayPath ?? result.path);
  } catch (error: unknown) {
    throw withNormalizeAdvice(error, input.path);
  }
};
