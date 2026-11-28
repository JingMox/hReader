// Shared adversarial checker: a structural diff between two HTML documents,
// built directly on parse5 — deliberately not on any hReader serializer or model,
// so it can judge feature output independently.
//
// Use it to prove a surgical edit (patch, annotation, inject) touched ONLY the
// intended subtree: every element outside the edited subtree is compared node by
// node — tag, attributes, own direct text, and the ancestor tag chain.

import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

type AnyNode = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/**
 * Decides whether an element is the root of the legitimately-edited subtree.
 * The element and everything under it is excluded from the comparison — in BOTH documents.
 */
export type EditedElementLocator = (element: Element) => boolean;

/** Locates the edited element by one attribute, e.g. `byAttribute("data-hr-id", "hr-c4")`. */
export const byAttribute = (name: string, value: string): EditedElementLocator => {
  return (element) => element.attrs.some((attr) => attr.name === name && attr.value === value);
};

/** Locates the edited element by tag, e.g. `byTag("article")` — useful when ids are not present. */
export const byTag = (tag: string): EditedElementLocator => {
  return (element) => element.tagName === tag;
};

export type StructureDiffKind =
  /** Present only in `before` (index fell off the end of `after`). */
  | "missing-after"
  /** Present only in `after` (index fell off the end of `before`). */
  | "extra-after"
  | "tag"
  | "attributes"
  | "own-text"
  | "ancestors";

/** One structural difference outside the edited subtree. */
export interface StructureDiff {
  /** Position in each document's element list (document order, edited subtrees excluded). */
  readonly index: number;
  readonly kind: StructureDiffKind;
  /** `ancestors/tag` context — from `before` when present, else from `after`. */
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

interface ElementSummary {
  readonly tag: string;
  /** Canonical `prefix:name="v"` pairs joined by space, sorted — order-insensitive. */
  readonly attrs: string;
  /** Concatenated own direct text (text children only, nothing deeper). */
  readonly text: string;
  /** The element's ancestor tag chain, `/`-joined ("" at document level). */
  readonly ancestors: string;
}

const attrsOf = (element: Element): string =>
  element.attrs
    .map(
      (attr) =>
        `${attr.prefix === undefined ? "" : `${attr.prefix}:`}${attr.name}=${JSON.stringify(attr.value)}`,
    )
    .sort()
    .join(" ");

const directTextOf = (element: Element): string =>
  element.childNodes
    .filter((child): child is DefaultTreeAdapterTypes.TextNode => "value" in child)
    .map((child) => child.value)
    .join("");

/** Children as parse5 exposes them: <template> contents live in `.content`, not `childNodes`. */
const childrenOf = (node: AnyNode): readonly AnyNode[] => {
  if (!("childNodes" in node)) return [];
  return "content" in node ? node.content.childNodes : node.childNodes;
};

const collect = (
  document: DefaultTreeAdapterTypes.Document,
  edited: EditedElementLocator | undefined,
): ElementSummary[] => {
  const out: ElementSummary[] = [];
  const walk = (node: AnyNode, ancestors: readonly string[]): void => {
    if ("tagName" in node) {
      if (edited?.(node) === true) return;
      out.push({
        tag: node.tagName,
        attrs: attrsOf(node),
        text: directTextOf(node),
        ancestors: ancestors.join("/"),
      });
      const next = [...ancestors, node.tagName];
      for (const child of childrenOf(node)) walk(child, next);
      return;
    }
    for (const child of childrenOf(node)) walk(child, ancestors);
  };
  walk(document, []);
  return out;
};

const pathOf = (summary: ElementSummary): string =>
  summary.ancestors === "" ? summary.tag : `${summary.ancestors}/${summary.tag}`;

/**
 * Parses both documents with parse5 (scripting OFF — `<noscript>` stays markup, matching
 * the server-side reading) and compares every element outside `edited`, index-aligned in
 * document order. An empty result means the edit stayed inside its subtree.
 */
export const diffStructure = (
  beforeHtml: string,
  afterHtml: string,
  edited?: EditedElementLocator,
): StructureDiff[] => {
  const before = collect(parse(beforeHtml, { scriptingEnabled: false }), edited);
  const after = collect(parse(afterHtml, { scriptingEnabled: false }), edited);
  const diffs: StructureDiff[] = [];
  const count = Math.max(before.length, after.length);
  for (let i = 0; i < count; i += 1) {
    const b = before[i];
    const a = after[i];
    if (b === undefined) {
      if (a !== undefined) {
        diffs.push({
          index: i,
          kind: "extra-after",
          path: pathOf(a),
          before: undefined,
          after: pathOf(a),
        });
      }
      continue;
    }
    if (a === undefined) {
      diffs.push({
        index: i,
        kind: "missing-after",
        path: pathOf(b),
        before: pathOf(b),
        after: undefined,
      });
      continue;
    }
    const path = pathOf(b);
    if (b.tag !== a.tag) diffs.push({ index: i, kind: "tag", path, before: b.tag, after: a.tag });
    if (b.attrs !== a.attrs)
      diffs.push({ index: i, kind: "attributes", path, before: b.attrs, after: a.attrs });
    if (b.text !== a.text)
      diffs.push({ index: i, kind: "own-text", path, before: b.text, after: a.text });
    if (b.ancestors !== a.ancestors)
      diffs.push({ index: i, kind: "ancestors", path, before: b.ancestors, after: a.ancestors });
  }
  return diffs;
};
