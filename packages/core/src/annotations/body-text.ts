// This layer: the body text domain for anchor matching — all text nodes under
// `<body>` in document order, minus the subtrees a reader can never see
// (`script`, `style`, `template`, `noscript`). Pure: no IO, no clock.

import type { HtmlNode, ParsedHtml } from "../html/constants";
import { drainStack } from "../html/stack";
import { elementsOf } from "./meta-insert";

/**
 * Raw-text and non-rendering subtrees whose text must not enter the domain:
 * an anchor quoting script/style bytes would re-land on invisible source, and
 * `template`/`noscript` children are inert markup that is never read as text.
 * `<script id="hr-meta">` is covered by `script` — its JSON is metadata, not prose.
 */
const TEXT_SKIP_TAGS: ReadonlySet<string> = new Set(["script", "style", "template", "noscript"]);

/**
 * All text under `<body>` in document order. `body` is implied by the parser
 * for every non-empty document, so the empty string only answers a body-less
 * (empty) document — the same fallback text the old whole-subtree read gave.
 */
export const bodyTextOf = (parsed: ParsedHtml): string => {
  const body = elementsOf(parsed.root).find((element) => element.tag === "body");
  if (body === undefined) return "";
  const parts: string[] = [];
  const stack: HtmlNode[] = [];
  for (let index = body.children.length - 1; index >= 0; index -= 1) {
    const child = body.children[index];
    if (child !== undefined) stack.push(child);
  }
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
  return parts.join("");
};
