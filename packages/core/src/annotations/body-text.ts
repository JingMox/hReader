// This layer: the body text domain for anchor matching — all text nodes under
// `<body>` in document order, minus the subtrees a reader can never see
// (`script`, `style`, `template`, `noscript`). Pure: no IO, no clock.

import type { HtmlElementNode, HtmlNode, ParsedHtml } from "../html/constants";
import { drainStack } from "../html/stack";
import { elementsOf } from "./meta-insert";

/**
 * Raw-text and non-rendering subtrees whose text must not enter the domain:
 * an anchor quoting script/style bytes would re-land on invisible source, and
 * `template`/`noscript` children are inert markup that is never read as text.
 * `<script id="hr-meta">` is covered by `script` — its JSON is metadata, not prose.
 */
const TEXT_SKIP_TAGS: ReadonlySet<string> = new Set(["script", "style", "template", "noscript"]);

/** A `[start, end)` slice of the body text — the interval one element's visible text covers. */
export interface BodySpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The body text plus, for every non-skipped element under `<body>` (and `<body>`
 * itself), the slice of that text the element's subtree covers. Elements inside
 * a skipped subtree get no span: their bytes never enter the domain.
 */
export interface BodyTextMap {
  readonly text: string;
  readonly spans: ReadonlyMap<HtmlElementNode, BodySpan>;
}

/**
 * One pass over `<body>` builds both the text and the per-element spans. An
 * enter/exit frame pair brackets each element: on enter we stamp `start`, on
 * exit we stamp `end`, so a span is exactly the text its subtree contributed.
 */
export const bodyMapOf = (parsed: ParsedHtml): BodyTextMap => {
  const body = elementsOf(parsed.root).find((element) => element.tag === "body");
  if (body === undefined) return { text: "", spans: new Map() };
  const parts: string[] = [];
  const spans = new Map<HtmlElementNode, { start: number; end: number }>();
  let length = 0;
  type Frame =
    | { readonly kind: "enter"; readonly node: HtmlNode }
    | { readonly kind: "exit"; readonly element: HtmlElementNode };
  const stack: Frame[] = [{ kind: "enter", node: body }];
  for (const frame of drainStack(stack)) {
    if (frame.kind === "exit") {
      const span = spans.get(frame.element);
      if (span !== undefined) span.end = length;
      continue;
    }
    const node = frame.node;
    if (node.kind === "text") {
      parts.push(node.value);
      length += node.value.length;
      continue;
    }
    if (node.kind !== "element" || TEXT_SKIP_TAGS.has(node.tag)) continue;
    spans.set(node, { start: length, end: length });
    stack.push({ kind: "exit", element: node });
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push({ kind: "enter", node: child });
    }
  }
  return { text: parts.join(""), spans };
};

/**
 * All text under `<body>` in document order. `body` is implied by the parser
 * for every non-empty document, so the empty string only answers a body-less
 * (empty) document — the same fallback text the old whole-subtree read gave.
 */
export const bodyTextOf = (parsed: ParsedHtml): string => bodyMapOf(parsed).text;
