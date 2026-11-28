// This layer: building the ≤200-code-point snippet around the first matched term, with
// `highlights` as offsets *within* the snippet — `snippet.slice(s, e)` reproduces a matched
// document term. Pure: no IO.

import { cutAtCodePoint } from "../text/truncate";
import { searchTokensOf } from "./tokenize";

const SNIPPET_CHARS = 200;
/** Leading context kept before the first match so it does not sit at column 0. */
const SNIPPET_LEAD = 48;

interface Snippet {
  readonly text: string;
  /** `[start, end)` offsets inside `text`, one per matched-term occurrence in the window. */
  readonly highlights: readonly (readonly [number, number])[];
}

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** `from` must not land between a surrogate pair: step back onto the pair's lead. */
const windowStartOf = (source: string, from: number): number =>
  from > 0 && isHigh(source.charCodeAt(from - 1)) && isLow(source.charCodeAt(from))
    ? from - 1
    : from;

/**
 * The window opens `SNIPPET_LEAD` units before the first matched token (or at 0), then takes
 * at most `SNIPPET_CHARS` units — `cutAtCodePoint` guarantees the tail never ends mid-pair.
 * A matched term that no longer sits in the text (the file moved between index and snippet)
 * yields the plain prefix with empty highlights rather than wrong offsets.
 */
export const snippetOf = (source: string, matchedTerms: readonly string[]): Snippet => {
  const wanted = new Set(matchedTerms);
  const spans = searchTokensOf(source).filter((token) => wanted.has(token.text));
  const first = spans[0];
  if (first === undefined) {
    return { text: cutAtCodePoint(source, SNIPPET_CHARS), highlights: [] };
  }
  const from = windowStartOf(source, Math.max(0, first.start - SNIPPET_LEAD));
  const text = cutAtCodePoint(source.slice(from, from + SNIPPET_CHARS), SNIPPET_CHARS);
  const end = from + text.length;
  const highlights = spans
    .filter((token) => token.start >= from && token.end <= end)
    .map((token): readonly [number, number] => [token.start - from, token.end - from]);
  return { text, highlights };
};
