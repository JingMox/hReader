// This layer: `hr outline` (read file -> preflight -> parse -> outline -> text/JSON); no argument checks, no exit codes.
// Diagnostics are visible in both modes: inside the envelope under `--json`, via `warn` in human mode (SKILL.md: headings without ids appear as warnings on stderr).

import { buildOutline, parseHtml } from "@hreader/core";

import { assertIsDocument, assertNormalized, assertUniqueIds } from "../document-normalize";
import { readTextFile } from "../input";
import { dataOutline, humanDiagnostic, humanOutline, jsonOk } from "../output";

export interface OutlineInput {
  readonly path: string;
  readonly json: boolean;
  /** Path printed in the empty-outline note (user's view); default = `path`. */
  readonly displayPath?: string | undefined;
  /** Diagnostics outlet (human mode); default = discard (when a unit test only needs the returned string). */
  readonly warn?: (message: string) => void;
}

export const outlineCommand = async (input: OutlineInput): Promise<string> => {
  const parsed = parseHtml(await readTextFile(input.path));
  assertIsDocument(parsed, input.path);
  assertUniqueIds(parsed, input.path);
  assertNormalized(parsed, input.path);
  const outline = buildOutline(parsed);
  if (input.json) return jsonOk(dataOutline(outline));
  for (const diagnostic of outline.diagnostics) input.warn?.(humanDiagnostic(diagnostic));
  return humanOutline(outline, input.displayPath ?? input.path);
};
