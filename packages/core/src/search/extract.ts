// This layer: turning one HTML document into the fields the index stores — `<title>` (else the
// first `<h1>`), every heading's text, and the visible body text (`bodyTextOf` on the default
// parse). Pure: no IO, no clock; the caller owns reading the bytes.

import { bodyTextOf } from "../annotations/body-text";
import { elementsOf } from "../annotations/meta-insert";
import type { HtmlNode } from "../html/constants";
import { parseHtml } from "../html/parse";
import { normalizeWhitespace, textContentOf } from "../html/text";
import { cutAtCodePoint } from "../text/truncate";

/** Per-document indexed text cap: a pathological body cannot blow up the persisted index. */
export const BODY_TEXT_CAP = 200 * 1024;

export interface ExtractedDocFields {
  /** `<title>` text, falling back to the first `<h1>`; `""` when neither exists. */
  readonly title: string;
  /** All `h1`–`h6` texts joined with spaces (one indexed field). */
  readonly headings: string;
  /** Visible body text, whitespace-normalized and capped at `BODY_TEXT_CAP`. */
  readonly body: string;
}

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const firstTextOf = (root: HtmlNode, tag: string): string | undefined =>
  elementsOf(root)
    .filter((element) => element.tag === tag)
    .map((element) => normalizeWhitespace(textContentOf(element)))
    .find((text) => text !== "");

/** Extraction order per the design: `<title>` first, then the first `<h1>`, then nothing. */
export const extractDocFields = (html: string): ExtractedDocFields => {
  const parsed = parseHtml(html);
  const headings = elementsOf(parsed.root)
    .filter((element) => HEADING_TAGS.has(element.tag))
    .map((element) => normalizeWhitespace(textContentOf(element)))
    .filter((text) => text !== "")
    .join(" ");
  return {
    title: firstTextOf(parsed.root, "title") ?? firstTextOf(parsed.root, "h1") ?? "",
    headings,
    body: cutAtCodePoint(normalizeWhitespace(bodyTextOf(parsed)), BODY_TEXT_CAP),
  };
};
