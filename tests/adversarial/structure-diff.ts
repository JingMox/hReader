// Shared adversarial checker: a structural diff between two HTML documents,
// built directly on parse5 — deliberately not on any hReader serializer or model,
// so it can judge feature output independently.
//
// Use it to prove a surgical edit (patch, annotation, inject) touched ONLY the
// intended subtree: every element, comment and doctype OUTSIDE the edited
// subtree is compared node by node — tag, attributes, own direct text, the
// sibling order of all child node kinds, and the ancestor tag chain — while the
// edited subtree is excluded wherever it lands.

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
  /** Same position, different order of child node kinds (text vs comment vs element). */
  | "child-order"
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

/**
 * Optional out-param a caller can pass to observe the walk's cost. Filled in
 * place, never read back by the checker. The counters exist so self-tests can
 * assert structural bounds (linear visits, shared ancestor chains, strings
 * materialized only for reported diffs) instead of wall-clock budgets.
 */
export interface DiffStructureStats {
  /** Frames popped during collection — one per visited node, both documents. */
  nodesVisited: number;
  /** Interned ancestor-chain objects created — shared across both documents. */
  chainsCreated: number;
  /**
   * Ancestor-chain strings materialized. Zero when the documents are identical:
   * a chain is stringified only to fill a reported diff or the `moved` message.
   */
  chainStringsBuilt: number;
}

export interface DiffStructureOptions {
  /**
   * Permit the edited element to sit at a different ancestor chain or sibling
   * index in `after` — for patches whose contract includes re-ordering. Default
   * false: an unmatched position change is reported as `moved`.
   */
  readonly allowMove?: boolean;
  /** Optional counters object the run fills — see {@link DiffStructureStats}. */
  readonly stats?: DiffStructureStats;
}

type SummaryKind = "element" | "comment" | "doctype";

/**
 * An interned ancestor chain: one object per unique (parent chain, tag) pair,
 * shared by BOTH documents through a single table. A sibling's children reuse
 * the parent's chain — flat documents stay flat — and identical chains in the
 * two documents are the same object, so ancestor comparison is a reference
 * check. The `/`-joined string is built lazily (see `chainString`) and only
 * when a diff needs it, so a clean run never pays O(depth) string copies.
 */
interface Chain {
  readonly tag: string;
  readonly parent: Chain | null;
  kids?: Map<string, Chain> | undefined;
  str?: string | undefined;
}

interface NodeSummary {
  readonly node: SummaryKind;
  /** tagName for elements, "#comment" for comments, "!doctype" for the doctype. */
  readonly tag: string;
  /** Canonical `prefix:name="v"` pairs joined by space, sorted — order-insensitive. */
  readonly attrs: string;
  /** Elements: concatenated own direct text. Comments: the comment data. Doctype: "". */
  readonly text: string;
  /**
   * Kind letters of the node's children in document order — `E` element, `T`
   * text-ish, `C` comment, `X` other — with the located edited element skipped.
   * Catches reorders that aligned-list comparison cannot (e.g. text vs comment
   * inside one element).
   */
  readonly order: string;
  /** The node's ancestor chain — interned, compared by reference. */
  readonly chain: Chain;
}

/** Where the located edited element sits — used by the move check. */
interface MatchPosition {
  readonly tag: string;
  readonly chain: Chain;
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

/** The interned child chain for (parent, tag) — created once per unique pair. */
const childChain = (parent: Chain, tag: string, stats?: DiffStructureStats): Chain => {
  const kids = (parent.kids ??= new Map<string, Chain>());
  let chain = kids.get(tag);
  if (chain === undefined) {
    chain = { tag, parent };
    kids.set(tag, chain);
    if (stats !== undefined) stats.chainsCreated += 1;
  }
  return chain;
};

/**
 * The `/`-joined ancestor string of a chain, materialized at most once per
 * unique chain — called only when a diff is actually reported, so identical
 * documents never build a single string.
 */
const chainString = (chain: Chain, stats?: DiffStructureStats): string => {
  if (chain.str === undefined) {
    if (stats !== undefined) stats.chainStringsBuilt += 1;
    const parts: string[] = [];
    for (let at = chain; at.parent !== null; at = at.parent) parts.push(at.tag);
    chain.str = parts.reverse().join("/");
  }
  return chain.str;
};

interface Frame {
  readonly node: AnyNode;
  readonly chain: Chain;
  /** Index among the element siblings under the same parent (-1 for non-elements). */
  readonly siblingIndex: number;
}

/**
 * Pushes one frame per child in reverse so pops follow document order; element
 * siblings carry their forward index. Never spreads children into a call —
 * a parent with hundreds of thousands of children would hit the engine's
 * argument-count limit (RangeError).
 */
const pushChildren = (stack: Frame[], parent: AnyNode, chain: Chain): void => {
  const kids = childrenOf(parent);
  let elIndex = 0;
  for (const kid of kids) {
    if ("tagName" in kid) elIndex += 1;
  }
  for (let i = kids.length - 1; i >= 0; i -= 1) {
    const child = kids[i];
    if (child === undefined) continue;
    const isElement = "tagName" in child;
    if (isElement) elIndex -= 1;
    stack.push({ node: child, chain, siblingIndex: isElement ? elIndex : -1 });
  }
};

/**
 * Kind letters of `node`'s children in order — `E` element, `C` comment
 * (including bogus comments like `<?x>`), `T` text/cdata-ish, `X` anything
 * else. The located edited element is skipped: the edit's own position is
 * judged by the `moved` check, not by its parent's order signature.
 */
const orderSignature = (node: AnyNode, edited: EditedElementLocator | undefined): string => {
  let sig = "";
  for (const child of childrenOf(node)) {
    if ("tagName" in child) {
      if (edited?.(child) !== true) sig += "E";
    } else if (child.nodeName === "#comment") {
      sig += "C";
    } else if ("value" in child || "data" in child) {
      sig += "T";
    } else {
      sig += "X";
    }
  }
  return sig;
};

const collect = (
  document: DefaultTreeAdapterTypes.Document,
  edited: EditedElementLocator | undefined,
  label: string,
  rootChain: Chain,
  stats?: DiffStructureStats,
): Collected => {
  const list: NodeSummary[] = [];
  const matches: MatchPosition[] = [];
  // An explicit stack, not recursion — corpus documents nest thousands deep.
  const stack: Frame[] = [];
  pushChildren(stack, document, rootChain);
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (stats !== undefined) stats.nodesVisited += 1;
    const { node, chain, siblingIndex } = frame;
    if ("tagName" in node) {
      if (edited?.(node) === true) {
        matches.push({ tag: node.tagName, chain, siblingIndex });
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
        order: orderSignature(node, edited),
        chain,
      });
      if (childrenOf(node).length > 0) {
        pushChildren(stack, node, childChain(chain, node.tagName, stats));
      }
      continue;
    }
    if (node.nodeName === "#comment" && "data" in node) {
      // Also catches bogus comments — `<?x>` and `<!x>` parse to comment nodes.
      list.push({
        node: "comment",
        tag: "#comment",
        attrs: "",
        text: node.data,
        order: "",
        chain,
      });
      continue;
    }
    if (node.nodeName === "#documentType") {
      const attrs =
        `name=${JSON.stringify(node.name)} ` +
        `publicId=${JSON.stringify(node.publicId)} ` +
        `systemId=${JSON.stringify(node.systemId)}`;
      list.push({ node: "doctype", tag: "!doctype", attrs, text: "", order: "", chain });
      continue;
    }
    pushChildren(stack, node, chain);
  }
  return { list, match: matches[0] };
};

const pathOf = (summary: NodeSummary, stats?: DiffStructureStats): string => {
  const ancestors = chainString(summary.chain, stats);
  return ancestors === "" ? summary.tag : `${ancestors}/${summary.tag}`;
};

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
  const stats = options?.stats;
  // One root chain shared by both collects — identical ancestor chains across
  // the documents intern to the same object, so `b.chain === a.chain` is
  // equality and `!==` is a real difference.
  const rootChain: Chain = { tag: "", parent: null, str: "" };
  const before = collect(
    parse(beforeHtml, { scriptingEnabled: false }),
    edited,
    "before",
    rootChain,
    stats,
  );
  const after = collect(
    parse(afterHtml, { scriptingEnabled: false }),
    edited,
    "after",
    rootChain,
    stats,
  );
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
          path: pathOf(a, stats),
          before: undefined,
          after: pathOf(a, stats),
        });
      }
      continue;
    }
    if (a === undefined) {
      diffs.push({
        index: i,
        kind: "missing-after",
        path: pathOf(b, stats),
        before: pathOf(b, stats),
        after: undefined,
      });
      continue;
    }
    if (b.node !== a.node) {
      diffs.push({
        index: i,
        kind: "node-kind",
        path: pathOf(b, stats),
        before: b.node,
        after: a.node,
      });
      continue;
    }
    if (b.tag !== a.tag)
      diffs.push({ index: i, kind: "tag", path: pathOf(b, stats), before: b.tag, after: a.tag });
    if (b.attrs !== a.attrs)
      diffs.push({
        index: i,
        kind: "attributes",
        path: pathOf(b, stats),
        before: b.attrs,
        after: a.attrs,
      });
    if (b.text !== a.text)
      diffs.push({
        index: i,
        kind: "own-text",
        path: pathOf(b, stats),
        before: b.text,
        after: a.text,
      });
    if (b.order !== a.order)
      diffs.push({
        index: i,
        kind: "child-order",
        path: pathOf(b, stats),
        before: b.order,
        after: a.order,
      });
    if (b.chain !== a.chain)
      diffs.push({
        index: i,
        kind: "ancestors",
        path: pathOf(b, stats),
        before: chainString(b.chain, stats),
        after: chainString(a.chain, stats),
      });
  }
  const { match: beforeMatch } = before;
  const { match: afterMatch } = after;
  if (
    options?.allowMove !== true &&
    beforeMatch !== undefined &&
    afterMatch !== undefined &&
    (beforeMatch.chain !== afterMatch.chain || beforeMatch.siblingIndex !== afterMatch.siblingIndex)
  ) {
    const beforeAncestors = chainString(beforeMatch.chain, stats);
    const afterAncestors = chainString(afterMatch.chain, stats);
    diffs.push({
      index: -1,
      kind: "moved",
      path: `${beforeAncestors}/${beforeMatch.tag}`,
      before: `${beforeAncestors}[${String(beforeMatch.siblingIndex)}]`,
      after: `${afterAncestors}[${String(afterMatch.siblingIndex)}]`,
    });
  }
  return diffs;
};
