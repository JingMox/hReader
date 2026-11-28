// Shared adversarial checker: a structural diff between two HTML documents,
// built directly on parse5 — deliberately not on any hReader serializer or model,
// so it can judge feature output independently.
//
// Use it to prove a surgical edit (patch, annotation, inject) touched ONLY the
// intended subtree: every element, comment and doctype OUTSIDE the edited
// subtree is compared node by node — tag, attributes, own direct text, and the
// ancestor tag chain — while the edited subtree is excluded wherever it lands.

import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

type AnyNode = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/**
 * Decides whether an element is the root of the legitimately-edited subtree.
 * The element and everything under it is excluded from the comparison — in BOTH
 * documents. It must identify AT MOST one element per document: matching two or
 * more elements throws (an ambiguous locator would silently excuse whole
 * subtrees); matching zero is allowed and is how inserts and deletes are
 * expressed — for an insert the element lands in the aligned list as
 * `extra-after` and the caller asserts its position separately.
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
  /** Same position, different node kind (element vs comment vs doctype). */
  | "node-kind"
  | "tag"
  | "attributes"
  | "own-text"
  | "ancestors"
  /** The located edited element sits at a different ancestor chain or sibling index. */
  | "moved";

/** One structural difference outside the edited subtree. */
export interface StructureDiff {
  /**
   * Position in each document's aligned node list (document order, edited
   * subtrees excluded). `-1` for `moved`, which is about the edited element
   * itself — it never appears in the aligned list.
   */
  readonly index: number;
  readonly kind: StructureDiffKind;
  /** `ancestors/tag` context — from `before` when present, else from `after`. */
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

export interface DiffStructureOptions {
  /**
   * Permit the edited element to sit at a different ancestor chain or sibling
   * index in `after` — for patches whose contract includes re-ordering. Default
   * false: an unmatched position change is reported as `moved`.
   */
  readonly allowMove?: boolean;
}

type SummaryKind = "element" | "comment" | "doctype";

interface NodeSummary {
  readonly node: SummaryKind;
  /** tagName for elements, "#comment" for comments, "!doctype" for the doctype. */
  readonly tag: string;
  /** Canonical `prefix:name="v"` pairs joined by space, sorted — order-insensitive. */
  readonly attrs: string;
  /** Elements: concatenated own direct text. Comments: the comment data. Doctype: "". */
  readonly text: string;
  /** The node's ancestor tag chain, `/`-joined ("" at document level). */
  readonly ancestors: string;
}

/** Where the located edited element sits — used by the move check. */
interface MatchPosition {
  readonly tag: string;
  readonly ancestors: string;
  /** Index among the element siblings under the same parent. */
  readonly siblingIndex: number;
}

interface Collected {
  readonly list: readonly NodeSummary[];
  readonly match: MatchPosition | undefined;
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

interface Frame {
  readonly node: AnyNode;
  readonly ancestors: readonly string[];
  /** Index among the element siblings under the same parent (-1 for non-elements). */
  readonly siblingIndex: number;
}

/** One frame per child, in document order; element siblings carry their index. */
const childFrames = (node: AnyNode, ancestors: readonly string[]): Frame[] => {
  const frames: Frame[] = [];
  let elIndex = 0;
  for (const child of childrenOf(node)) {
    const isElement = "tagName" in child;
    frames.push({ node: child, ancestors, siblingIndex: isElement ? elIndex : -1 });
    if (isElement) elIndex += 1;
  }
  return frames;
};

const collect = (
  document: DefaultTreeAdapterTypes.Document,
  edited: EditedElementLocator | undefined,
  label: string,
): Collected => {
  const list: NodeSummary[] = [];
  const matches: MatchPosition[] = [];
  // An explicit stack, not recursion — corpus documents nest thousands deep.
  const stack: Frame[] = childFrames(document, []).reverse();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { node, ancestors, siblingIndex } = frame;
    if ("tagName" in node) {
      if (edited?.(node) === true) {
        matches.push({ tag: node.tagName, ancestors: ancestors.join("/"), siblingIndex });
        if (matches.length > 1) {
          throw new Error(
            `edited locator matched ${String(matches.length)} elements in the ${label} document — it must identify at most one element`,
          );
        }
        continue;
      }
      list.push({
        node: "element",
        tag: node.tagName,
        attrs: attrsOf(node),
        text: directTextOf(node),
        ancestors: ancestors.join("/"),
      });
      stack.push(...childFrames(node, [...ancestors, node.tagName]).reverse());
      continue;
    }
    if (node.nodeName === "#comment" && "data" in node) {
      // Also catches bogus comments — `<?x>` and `<!x>` parse to comment nodes.
      list.push({
        node: "comment",
        tag: "#comment",
        attrs: "",
        text: node.data,
        ancestors: ancestors.join("/"),
      });
      continue;
    }
    if (node.nodeName === "#documentType") {
      const attrs =
        `name=${JSON.stringify(node.name)} ` +
        `publicId=${JSON.stringify(node.publicId)} ` +
        `systemId=${JSON.stringify(node.systemId)}`;
      list.push({ node: "doctype", tag: "!doctype", attrs, text: "", ancestors: "" });
      continue;
    }
    stack.push(...childFrames(node, ancestors).reverse());
  }
  return { list, match: matches[0] };
};

const pathOf = (summary: NodeSummary): string =>
  summary.ancestors === "" ? summary.tag : `${summary.ancestors}/${summary.tag}`;

/**
 * Parses both documents with parse5 (scripting OFF — `<noscript>` stays markup, matching
 * the server-side reading) and compares every node outside `edited`, index-aligned in
 * document order. An empty result means the edit stayed inside its subtree.
 *
 * The edited subtree is excluded wherever it lands — but when the locator matches
 * exactly once in each document, its ancestor chain and element-sibling index are
 * still compared, and a change is reported as `moved` unless `options.allowMove`.
 */
export const diffStructure = (
  beforeHtml: string,
  afterHtml: string,
  edited?: EditedElementLocator,
  options?: DiffStructureOptions,
): StructureDiff[] => {
  const before = collect(parse(beforeHtml, { scriptingEnabled: false }), edited, "before");
  const after = collect(parse(afterHtml, { scriptingEnabled: false }), edited, "after");
  const diffs: StructureDiff[] = [];
  const count = Math.max(before.list.length, after.list.length);
  for (let i = 0; i < count; i += 1) {
    const b = before.list[i];
    const a = after.list[i];
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
    if (b.node !== a.node) {
      diffs.push({ index: i, kind: "node-kind", path, before: b.node, after: a.node });
      continue;
    }
    if (b.tag !== a.tag) diffs.push({ index: i, kind: "tag", path, before: b.tag, after: a.tag });
    if (b.attrs !== a.attrs)
      diffs.push({ index: i, kind: "attributes", path, before: b.attrs, after: a.attrs });
    if (b.text !== a.text)
      diffs.push({ index: i, kind: "own-text", path, before: b.text, after: a.text });
    if (b.ancestors !== a.ancestors)
      diffs.push({ index: i, kind: "ancestors", path, before: b.ancestors, after: a.ancestors });
  }
  const { match: beforeMatch } = before;
  const { match: afterMatch } = after;
  if (
    options?.allowMove !== true &&
    beforeMatch !== undefined &&
    afterMatch !== undefined &&
    (beforeMatch.ancestors !== afterMatch.ancestors ||
      beforeMatch.siblingIndex !== afterMatch.siblingIndex)
  ) {
    diffs.push({
      index: -1,
      kind: "moved",
      path: `${beforeMatch.ancestors}/${beforeMatch.tag}`,
      before: `${beforeMatch.ancestors}[${String(beforeMatch.siblingIndex)}]`,
      after: `${afterMatch.ancestors}[${String(afterMatch.siblingIndex)}]`,
    });
  }
  return diffs;
};
