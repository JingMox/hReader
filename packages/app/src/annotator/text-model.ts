// DOM twin of core's `bodyMapOf` (packages/core/src/annotations/body-text.ts): the
// exact same text domain — text nodes under <body> in document order, skipping
// script/style/template/noscript subtrees — plus per-element spans and a
// selector-path builder matching core's grammar (`body > tag:nth-of-type(n) > …`).
// The hr-meta marker element needs no special case: served docs carry it as
// `<script id="hr-meta">`, already covered by the tag skip. A NON-script element
// with that id is just foreign markup — skipping it would break parity with core.
// No prototype methods are called on frame-provided objects where avoidable: a
// page that poisoned them can only degrade the engine, never escape the callers'
// try/catch.

import type { DomElementLike, DomNodeLike, DomTextLike } from "./shapes.ts";

const TEXT_SKIP_TAGS: ReadonlySet<string> = new Set(["script", "style", "template", "noscript"]);

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Selector-path limits mirrored from core's SELECTOR_LIMITS. */
const SELECTOR_STEPS_LIMIT = 64;
const SELECTOR_CHARS_LIMIT = 1024;
const SELECTOR_NTH_LIMIT = 9999;
const NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;

export interface DomPoint {
  readonly node: DomNodeLike;
  readonly offset: number;
}

export interface BodySpan {
  readonly start: number;
  readonly end: number;
}

export interface DomTextMap {
  /** The body text: identical bytes to core's bodyTextOf for the same document. */
  readonly text: string;
  /** Body-text offset of a DOM point, or undefined when the point is outside the counted domain. */
  readonly offsetOfPoint: (node: DomNodeLike, offset: number) => number | undefined;
  /** DOM point for a body-text offset (0..text.length), or undefined when out of range. */
  readonly pointAt: (offset: number) => DomPoint | undefined;
  /** Selector path for an element under body, or undefined when over limits / not under body. */
  readonly selectorOf: (element: DomElementLike) => string | undefined;
  /** Body-text span of an element (tests + debugging). */
  readonly spanOf: (element: DomElementLike) => BodySpan | undefined;
}

interface TextEntry {
  readonly node: DomNodeLike;
  readonly start: number;
  readonly end: number;
}

type Frame = { kind: "enter"; node: DomNodeLike } | { kind: "exit"; element: DomElementLike };

const skipElement = (element: DomElementLike): boolean => TEXT_SKIP_TAGS.has(element.localName);

/**
 * Iterative document-order walk mirroring core's drainStack: enter pushes an exit
 * frame plus children in reverse order, so leaves emit in order while parent spans
 * close after their last child.
 */
const collect = (
  body: DomElementLike,
): { parts: string[]; texts: TextEntry[]; spans: Map<DomElementLike, BodySpan> } => {
  const parts: string[] = [];
  const texts: TextEntry[] = [];
  const spans = new Map<DomElementLike, BodySpan>();
  let length = 0;
  const stack: Frame[] = [{ kind: "enter", node: body }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const node = frame.kind === "enter" ? frame.node : frame.element;
    if (frame.kind === "enter" && node.nodeType === TEXT_NODE) {
      const data = (node as DomTextLike).data;
      parts[parts.length] = data;
      texts[texts.length] = { node, start: length, end: length + data.length };
      length += data.length;
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const element = node as DomElementLike;
    if (frame.kind === "enter" && skipElement(element)) continue;
    if (frame.kind === "enter") {
      const start = length;
      spans.set(element, { start, end: start });
      stack.push({ kind: "exit", element });
      const children = element.childNodes;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (child !== undefined) stack.push({ kind: "enter", node: child });
      }
      continue;
    }
    const span = spans.get(element);
    if (span !== undefined) spans.set(element, { start: span.start, end: length });
  }
  return { parts, texts, spans };
};

const nthOfType = (parent: DomElementLike, element: DomElementLike): number => {
  let nth = 0;
  for (const sib of parent.children) {
    if (sib.localName === element.localName) nth += 1;
    if (sib === element) break;
  }
  return nth;
};

/**
 * Recursive body-ward walk: `depth` is the element's distance from `element`
 * itself (1 = the queried element). Fails on detached chains, over-limit depth,
 * grammar-breaking tags and over-limit nth-of-type — same gates as the
 * iterative chain version (chain length ≥ limit ⇔ depth ≥ limit).
 */
const selectorPath = (
  body: DomElementLike,
  element: DomElementLike,
  depth: number,
): string | undefined => {
  if (element === body) return "body";
  const parent = element.parentElement;
  if (parent === null || depth > SELECTOR_STEPS_LIMIT - 1) return undefined;
  const prefix = selectorPath(body, parent, depth + 1);
  if (prefix === undefined) return undefined;
  const tag = element.localName;
  // Core's grammar lowercases names on parse — a camelCase tag (SVG foreign
  // content) can never resolve, so emit nothing and let the body fallback take it.
  if (!NAME_RE.test(tag) || tag.toLowerCase() !== tag) return undefined;
  const nth = nthOfType(parent, element);
  if (nth > SELECTOR_NTH_LIMIT) return undefined;
  const path = `${prefix} > ${nth === 1 ? tag : `${tag}:nth-of-type(${String(nth)})`}`;
  return path.length > SELECTOR_CHARS_LIMIT ? undefined : path;
};

export const domBodyMapOf = (body: DomElementLike): DomTextMap => {
  const { parts, texts, spans } = collect(body);
  let text = "";
  for (const part of parts) {
    text += part;
  }
  const textIndex = new Map<DomNodeLike, TextEntry>();
  for (const entry of texts) {
    textIndex.set(entry.node, entry);
  }

  const offsetOfPoint = (node: DomNodeLike, offset: number): number | undefined => {
    if (node.nodeType === TEXT_NODE) {
      const entry = textIndex.get(node);
      if (entry === undefined) return undefined;
      const span = entry.end - entry.start;
      return entry.start + (offset < span ? offset : span);
    }
    if (node.nodeType !== ELEMENT_NODE) return undefined;
    const element = node as DomElementLike;
    const span = spans.get(element);
    if (span === undefined) return undefined;
    const limit = offset < element.childNodes.length ? offset : element.childNodes.length;
    let acc = span.start;
    let i = 0;
    for (const child of element.childNodes) {
      if (i >= limit) break;
      i += 1;
      if (child.nodeType === TEXT_NODE) {
        const entry = textIndex.get(child);
        acc += entry === undefined ? 0 : entry.end - entry.start;
      } else if (child.nodeType === ELEMENT_NODE) {
        const sub = spans.get(child as DomElementLike);
        acc += sub === undefined ? 0 : sub.end - sub.start;
      }
    }
    return acc;
  };

  const pointAt = (offset: number): DomPoint | undefined => {
    if (offset < 0 || offset > text.length || texts.length === 0) return undefined;
    // texts is sorted by `end` and the last entry's end is text.length, so an
    // in-bounds offset always has a qualifying entry — `found` is set.
    let found: DomPoint | undefined;
    for (const entry of texts) {
      if (entry.end >= offset) {
        found = { node: entry.node, offset: offset - entry.start };
        break;
      }
    }
    return found;
  };

  return {
    text,
    offsetOfPoint,
    pointAt,
    selectorOf: (element) => selectorPath(body, element, 1),
    spanOf: (element) => spans.get(element),
  };
};

/** Walk parentNode until body — avoids Node.contains (a clobberable prototype method). */
export const insideBody = (body: DomElementLike, node: DomNodeLike): boolean => {
  let cursor: DomNodeLike | null = node;
  while (cursor !== null) {
    if (cursor === body) return true;
    cursor = cursor.parentNode;
  }
  return false;
};

/** The element a range boundary hangs on: its parent for text nodes, itself otherwise. */
export const elementOfPoint = (node: DomNodeLike): DomElementLike | undefined => {
  if (node.nodeType === ELEMENT_NODE) return node as DomElementLike;
  return node.parentElement ?? undefined;
};
