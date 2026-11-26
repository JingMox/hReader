// This layer: `hr check` (document-level diagnostics + layout-constraint checks + foreign-HTML classification) -> text/JSON;
// read-only, never edits the document; `--strict`'s "report first, then fail" works by StrictFailure carrying the report back to the dispatch layer.

import { checkLayout, classifyDocument, parseHtml, validateDocument } from "@hreader/core";

import type { StrictLevel } from "../args";
import { StrictFailure } from "../errors";
import { readTextFile } from "../input";
import { dataCheck, humanCheck, jsonOk } from "../output";

export interface CheckInput {
  readonly path: string;
  readonly json: boolean;
  readonly strict?: StrictLevel | undefined;
  /** Path printed in the summary line (user's view): falls back to `path` when not given. */
  readonly displayPath?: string | undefined;
}

/**
 * No `needs_normalize` preflight: checking consumes no ids, and a document without ids can still be checked;
 * "no `<article>`" is not a separate error either — it is already one `validateDocument` diagnostic.
 */
export const checkCommand = async (input: CheckInput): Promise<string> => {
  const parsed = parseHtml(await readTextFile(input.path));
  const issues = [...validateDocument(parsed), ...checkLayout(parsed.root)];
  const classification = classifyDocument(parsed);
  const path = input.displayPath ?? input.path;
  const output = input.json
    ? jsonOk(dataCheck(issues, classification.cls, classification.reason))
    : humanCheck(issues, path, classification.cls === "foreign");
  if (input.strict === undefined) return output;
  const hits = issues.filter((issue) => input.strict === "warning" || issue.severity === "error");
  if (hits.length === 0) return output;
  const level = input.strict === "warning" ? "" : " error 级";
  throw new StrictFailure(`${path}：${String(hits.length)} 条${level}诊断（--strict）`, output);
};
