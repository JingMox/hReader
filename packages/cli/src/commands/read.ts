// This layer: `hr read` (read file -> read node -> HTML/JSON); no argument checks.
// No ad-hoc id injection here: computed ids are not on disk and feeding one back to `patch` fails (missing ids are written by `hr normalize`).
// The second positional's interpretation (selector first, then node id) lives in core's `locateTarget`, shared with `patch`.

import { type ParsedHtml, locateTarget, parseHtml, readNode } from "@hreader/core";

import { assertIsDocument, assertNormalized, assertUniqueIds } from "../document-normalize";
import { readTextFile } from "../input";
import { dataRead, humanRead, jsonOk } from "../output";

export interface ReadInput {
  readonly path: string;
  readonly target: string;
  readonly maxBytes: number | undefined;
  readonly json: boolean;
}

const ATTRIBUTE_ID = /data-hr-id="([^"]+)"/gu;

/** `ids` lists only ids actually present in the returned `html`: ids of other nodes in the document's injection table are dangling references for the caller. */
const idsOf = (html: string): readonly string[] =>
  [...html.matchAll(ATTRIBUTE_ID)].map((match) => String(match[1]));

/** The default cap comes from core: this layer only forwards the value when given. */
const readOnce = (
  parsed: ParsedHtml,
  selector: string,
  maxBytes: number | undefined,
): ReturnType<typeof readNode> =>
  maxBytes === undefined ? readNode(parsed, selector) : readNode(parsed, selector, maxBytes);

export const readCommand = async (input: ReadInput): Promise<string> => {
  const parsed = parseHtml(await readTextFile(input.path));
  // A document missing ids cannot be papered over by ad-hoc injection: computed ids are not on disk and feeding one back to patch fails.
  assertIsDocument(parsed, input.path);
  // Duplicate ids rank ahead of `needs_normalize`: that one means "ids are missing", this one means "two elements share one id".
  assertUniqueIds(parsed, input.path);
  assertNormalized(parsed, input.path);
  // The miss code comes from `locateTarget`; `readNode` only reads after a hit — resolving the same string twice is a cost, not semantics.
  const result = readOnce(parsed, locateTarget(parsed, input.target).selector, input.maxBytes);
  return input.json ? jsonOk(dataRead(result, idsOf(result.html))) : humanRead(result);
};
