// This layer: turning one HTML document into the fields the index stores — `<title>` (else the
// first `<h1>`), every heading's text, and the visible body text (`searchTextOf` on the default
// parse). Pure: no IO, no clock; the caller owns reading the bytes.

import { TEXT_SKIP_TAGS } from "../annotations/body-text";
import { elementsOf } from "../annotations/meta-insert";
import type { HtmlNode, ParsedHtml } from "../html/constants";
import { parseHtml } from "../html/parse";
import { drainStack } from "../html/stack";
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

/**
 * The INDEXED body text — not the anchor text. `bodyTextOf` joins text nodes with no
 * separator because anchors need raw adjacency; that glues `<td>module</td><td>1</td>`
 * into one token `module1` and kills recall. Here every text node is its own part, so a
 * space lands at every element boundary (`<b>foo</b>bar`, `a<br>b`, `<li>` rows), then
 * whitespace collapses to one run. Same visible-text domain, same skip rules.
 */
export const searchTextOf = (parsed: ParsedHtml): string => {
  const body = elementsOf(parsed.root).find((element) => element.tag === "body");
  if (body === undefined) return "";
  const parts: string[] = [];
  const stack: HtmlNode[] = [...body.children].reverse();
  for (const node of drainStack(stack)) {
    if (node.kind === "text") {
      parts.push(node.value);
      continue;
    }
    if (node.kind !== "element" || TEXT_SKIP_TAGS.has(node.tag)) continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return normalizeWhitespace(parts.join(" "));
};

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
    body: cutAtCodePoint(searchTextOf(parsed), BODY_TEXT_CAP),
  };
};
