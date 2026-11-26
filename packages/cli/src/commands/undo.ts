// This layer: `hr undo` (restore the file to the latest history snapshot) -> text/JSON; no argument parsing, no stdin.
// `revertLast` rather than `undoPatch`: "no history" maps to the outward `nothing_to_undo` in exactly one place.

import { nodePatchDeps, revertLast } from "@hreader/core";

import { dataUndo, humanUndo } from "../output";

export interface UndoInput {
  readonly path: string;
  readonly workspace: string;
  readonly json: boolean;
  /** Path printed in the receipt (user's view): falls back to the result's real path when not given. */
  readonly displayPath?: string | undefined;
}

export const undoCommand = async (input: UndoInput): Promise<string> => {
  const result = await revertLast({ workspace: input.workspace, file: input.path }, nodePatchDeps);
  return input.json ? dataUndo(result) : humanUndo(result, input.displayPath ?? result.path);
};
