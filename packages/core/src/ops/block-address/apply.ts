// This layer: the pure byte splice behind `patchBlock`. It resolves the address on the exact
// bytes it rewrites, validates the fragment through the managed-document pipeline
// (`fragment.ts` checks + the content-model gate), then replaces only the block's outerHTML
// range — every other byte is untouched. Block listing is heuristic, so a listed range may
// still hide unowned bytes, and two oracles are the construction-level guarantee:
//
// - `rangeIsExactlyOwned` (D60, pre-splice): the splice's REMOVED bytes are exactly the
//   block's own — re-parsing them must produce the original tree minus the block.
//   Runs for every action.
// - `writeKeepsContext` (D64, post-splice/pre-write — `replace`, `insertBefore`,
//   `insertAfter` only): the splice's ADDED bytes land where the action intends —
//   re-parsing the written result must produce the original tree with the fragment
//   spliced at the block's slot: every element outside the block keeps its tag,
//   attributes, own direct text and ancestor chain, and the fragment's top-level nodes
//   are children of the block's original parent at its position (replacing it, or
//   adjacent to it).
//
// D68: both oracles judge the RAW parse5 tree — the DOM the bytes actually build — not
// the normalized model (`closeImplicitParagraphs` hoists block content out of elements
// the real parser never closes: quirks-mode `<p>`+`<table>`, `button`/`select`/`object`/
// `marquee` scope boundaries, fostered content). A listed block maps to its raw twin
// through its source extent `[start, end)` — normalization only powers listing and
// fragment gates, never the judgment. Every oracle runs twice, once per scripting
// mode: a `<noscript>`-borne element does not exist when scripting is on, so a patch
// touching it cannot be verified and refuses. No IO, no id injection.

import type { DefaultTreeAdapterTypes } from "parse5";

import type { HtmlNode, SourceSpan } from "../../html/constants";
import { parseHtml, parseRawFragmentNodes, parseRawHtml } from "../../html/parse";
import { serializeHtml } from "../../html/serialize";
import { HrError } from "../../hr-error";
import { assertFragmentFits } from "../patch-node/content";
import { fragmentIdWarnings, parseFragmentWithDiagnostics } from "../patch-node/fragment";
import { parentElementOf } from "../patch-node/locate";
import { collectBlocks, formatAddress } from "./blocks";
import {
  BLOCK_ACTIONS,
  type BlockAction,
  type BlockPatchOutcome,
  type BlockPatchRequest,
} from "./constants";
import { locateBlock } from "./resolve";

/** Same contract as `patch-node/apply.ts`: `delete` carries no content, the others must. */
type FragmentRequest =
  | { readonly action: "delete" }
  | { readonly action: Exclude<BlockAction, "delete">; readonly html: string };

const isBlockAction = (value: BlockAction): value is BlockAction =>
  BLOCK_ACTIONS.some((action) => action === value);

const fragmentRequestOf = (request: BlockPatchRequest): FragmentRequest => {
  if (request.action === "delete") {
    // Stryker disable next-line StringLiteral: the contract pins the code, not the wording.
    if (request.html !== undefined) throw new HrError("invalid_input", "delete 不接受 html");
    return { action: "delete" };
  }
  if (request.html === undefined) {
    // Stryker disable next-line StringLiteral: the contract pins the code, not the wording.
    throw new HrError("invalid_input", `${request.action} 需要 html`);
  }
  return { action: request.action, html: request.html };
};

// Stryker disable next-line StringLiteral: the hint only lives inside a human-facing message.
const ADDRESS_HINT = "css:body > p:nth-of-type(1)@ab12cd34";

const locateError = (address: string, code: "target_moved" | "invalid_selector"): HrError =>
  code === "invalid_selector"
    ? new HrError(
        "invalid_selector",
        // Stryker disable next-line StringLiteral: the contract pins the code + data.reason, not the wording.
        `块地址无法解析：${JSON.stringify(address)}（期望形如 ${ADDRESS_HINT}）`,
        { data: { reason: "syntax" } },
      )
    : new HrError(
        "target_moved",
        // Stryker disable next-line StringLiteral: same — the contract pins the code, not the wording.
        `块地址已失效：${JSON.stringify(address)} —— 路径命中的块指纹已变（原块被原地编辑），或路径未命中块且全文找不到唯一的同指纹候选（被移动、删除或重复）；重新 list 取新地址`,
      );

type P5Node = DefaultTreeAdapterTypes.Node;
type P5Element = DefaultTreeAdapterTypes.Element;
type P5Document = DefaultTreeAdapterTypes.Document;

const isP5Element = (node: P5Node): node is P5Element => "tagName" in node;

/**
 * Children under the real parent-child relation: an HTML-namespace `template`
 * keeps its children on `content`, not `childNodes` (same rule `buildTree`
 * applies — only real template elements carry `content`; foreign `<template>`
 * is an ordinary element). Leaves answer an empty list.
 */
const childrenOf = (node: P5Node): readonly P5Node[] => {
  if (isP5Element(node) && "content" in node) return node.content.childNodes;
  if ("childNodes" in node) return (node as { childNodes: P5Node[] }).childNodes;
  return [];
};

/**
 * Ordered attribute equality on parse5 attributes — name, value, prefix and
 * namespace (foreign-content adjustment rewrites `xlink:href` & friends). The
 * parser keeps source order on both sides; `\0` can never appear in a parsed
 * name or value, so the joined encoding is exact.
 */
const sameAttrs = (
  left: DefaultTreeAdapterTypes.Element["attrs"],
  right: DefaultTreeAdapterTypes.Element["attrs"],
): boolean =>
  left
    .map((attr) => `${attr.name}\0${attr.value}\0${attr.prefix ?? ""}\0${attr.namespace ?? ""}`)
    .join("\0") ===
  right
    .map((attr) => `${attr.name}\0${attr.value}\0${attr.prefix ?? ""}\0${attr.namespace ?? ""}`)
    .join("\0");

/**
 * Adjacent text siblings folded into one run — a tree surgery can leave two text
 * nodes side by side where re-parsing produces a single merged one (an element's
 * "own direct text" is the concatenation either way). Comments still break runs.
 */
const textMerged = (children: readonly P5Node[]): readonly P5Node[] => {
  const merged: P5Node[] = [];
  for (const child of children) {
    const last = merged[merged.length - 1];
    if (child.nodeName === "#text" && last?.nodeName === "#text") {
      const combined = {
        ...(last as object),
        value:
          (last as DefaultTreeAdapterTypes.TextNode).value +
          (child as DefaultTreeAdapterTypes.TextNode).value,
      };
      merged[merged.length - 1] = combined as P5Node;
    } else {
      merged.push(child);
    }
  }
  return merged;
};

/**
 * The block's slot in a raw parse5 tree: its element, its real parent, and its
 * index in that parent's children. Normalization can reparent a block but never
 * changes its source extent — the same bytes give the same element location in
 * the raw parse.
 */
interface RawSlot {
  readonly node: P5Element;
  readonly parent: P5Node;
  readonly index: number;
}

/**
 * The raw twin of a listed block: the element whose source extent is exactly
 * `[start, end)` — start tag included, so implicit scaffold elements (which
 * carry no `startTag` location) can never match. No twin means the "block" does
 * not exist in this scripting mode's real DOM (e.g. a `<noscript>`-borne
 * element when scripting is on), and the patch cannot be verified.
 */
const findRawSlot = (root: P5Document, range: SourceSpan): RawSlot | undefined => {
  const pending: { node: P5Node; parent: P5Node; index: number }[] = childrenOf(root).map(
    (node, index) => ({ node, parent: root, index }),
  );
  // The queue grows while it is walked — for-of still visits pushed entries.
  for (const candidate of pending) {
    if (isP5Element(candidate.node)) {
      const location = candidate.node.sourceCodeLocation;
      if (
        location?.startTag !== undefined &&
        location.startOffset === range.start &&
        location.endOffset === range.end
      ) {
        return { node: candidate.node, parent: candidate.parent, index: candidate.index };
      }
      for (const [index, child] of childrenOf(candidate.node).entries()) {
        pending.push({ node: child, parent: candidate.node, index });
      }
    }
  }
  return undefined;
};

/**
 * One licensed difference in an otherwise identical tree: at `wound.parent`, the
 * child list must be exactly `wound.children` — everything else must match
 * node-by-node (nodeName, tag, namespace, attrs, payload, children). This is
 * what both oracles share: the delete oracle wounds the block's cut, the write
 * oracle wounds the fragment's splice.
 */
interface RawWound {
  readonly parent: P5Node;
  readonly children: readonly P5Node[];
}

/**
 * One node's own payload — nodeName plus whatever the kind carries (tag,
 * namespace, attrs for elements; text/comment data; doctype ids). Child lists
 * are the caller's concern: pair-wise comparison happens in the outer walk.
 * An unrecognized kind refuses the pair — a node the comparator does not know
 * cannot be verified.
 */
const payloadEq = (left: P5Node, right: P5Node): boolean => {
  if (left.nodeName !== right.nodeName) return false;
  if (isP5Element(left)) {
    const other = right as P5Element;
    return (
      left.tagName === other.tagName &&
      left.namespaceURI === other.namespaceURI &&
      sameAttrs(left.attrs, other.attrs)
    );
  }
  if (left.nodeName === "#text") {
    return left.value === (right as DefaultTreeAdapterTypes.TextNode).value;
  }
  if (left.nodeName === "#comment") {
    return left.data === (right as DefaultTreeAdapterTypes.CommentNode).data;
  }
  if (left.nodeName === "#documentType") {
    const other = right as DefaultTreeAdapterTypes.DocumentType;
    return (
      left.name === other.name &&
      left.publicId === other.publicId &&
      left.systemId === other.systemId
    );
  }
  return left.nodeName === "#document";
};

/**
 * Node-by-node equality between the expected tree (the original raw tree, whose
 * nodes carry `wound`) and the result tree. Iterative — depth-stress documents
 * overflow recursion: a listed block is address-bounded but its sibling
 * subtrees are not. Only at the wound's parent is the child list taken from
 * `wound.children` — merged, since a splice stitches boundary texts; every
 * other level compares the parse's own child list, strict.
 */
const sameTreeExceptWound = (left: P5Node, right: P5Node, wound: RawWound): boolean => {
  const pending: [P5Node, P5Node][] = [[left, right]];
  for (;;) {
    const pair = pending.pop();
    if (pair === undefined) break;
    const [a, b] = pair;
    if (!payloadEq(a, b)) return false;
    const atWound = a === wound.parent;
    const aKids = atWound ? textMerged(wound.children) : childrenOf(a);
    const bKids = atWound ? textMerged(childrenOf(b)) : childrenOf(b);
    if (aKids.length !== bKids.length) return false;
    for (const [index, childA] of aKids.entries()) {
      const childB = bKids[index];
      // The length check above puts `index` in bounds on both sides.
      /* v8 ignore next */
      if (childB === undefined) return false;
      pending.push([childA, childB]);
    }
  }
  return true;
};

/** The wound of a delete: the block's parent holds its children minus the block. */
const deleteWound = (slot: RawSlot): RawWound => {
  const kids = childrenOf(slot.parent);
  return {
    parent: slot.parent,
    children: [...kids.slice(0, slot.index), ...kids.slice(slot.index + 1)],
  };
};

/** The wound of a write: the fragment's top-level raw nodes spliced at the block's slot. */
const writeWound = (
  slot: RawSlot,
  fragment: readonly P5Node[],
  action: "replace" | "insertBefore" | "insertAfter",
): RawWound => {
  const kids = childrenOf(slot.parent);
  const children =
    action === "replace"
      ? [...kids.slice(0, slot.index), ...fragment, ...kids.slice(slot.index + 1)]
      : action === "insertBefore"
        ? [...kids.slice(0, slot.index), ...fragment, slot.node, ...kids.slice(slot.index + 1)]
        : [...kids.slice(0, slot.index + 1), ...fragment, ...kids.slice(slot.index + 1)];
  return { parent: slot.parent, children };
};

/**
 * The D60 pre-write oracle on the raw tree — what the splice REMOVES is guaranteed by
 * it. `result` is a raw re-parse of the byte-splice: it must be the original tree
 * minus the block's raw subtree, nothing else. A leftover foreign byte (an ignored
 * tag, fostered content, dropped markup) diverges the trees → not owned.
 */
const rangeIsExactlyOwned = (original: P5Document, result: P5Document, slot: RawSlot): boolean =>
  sameTreeExceptWound(original, result, deleteWound(slot));

/**
 * The D64 post-write oracle on the raw tree — what the splice ADDS is guaranteed by it.
 * `result` is a raw re-parse of the written bytes: it must be the original tree with
 * the fragment's top-level raw nodes at the block's slot — replacing it, or adjacent —
 * and nothing else changed. Scope-close, adoption-agency, foster parenting and
 * still-open elements (quirks `<p>`, `button`/`select`/`object`/`marquee` boundaries,
 * raw text) all reparent or drop nodes → divergence → nothing written. Namespace is
 * compared too: a fragment spliced into foreign content lands as e.g. `svg:select`,
 * which is not the HTML element the fragment's own parse produced.
 */
const writeKeepsContext = (
  original: P5Document,
  result: P5Document,
  slot: RawSlot,
  fragment: readonly P5Node[],
  action: "replace" | "insertBefore" | "insertAfter",
): boolean => sameTreeExceptWound(original, result, writeWound(slot, fragment, action));

/** The address of the first leaf block fully inside `[from, to)` of `html` — the written range. */
const firstBlockAddressIn = (html: string, from: number, to: number): string | undefined => {
  const entries = collectBlocks(parseHtml(html, { locations: true }).root, html);
  for (const entry of entries) {
    if (entry.range.start >= from && entry.range.end <= to) return formatAddress(entry);
  }
  return undefined;
};

const fragmentText = (fragment: HtmlNode): string =>
  // serializeHtml only reads `root`; the diagnostics field is dead weight required by the
  // ParsedHtml shape.
  // Stryker disable next-line ArrayDeclaration
  serializeHtml({ root: { kind: "document", children: [fragment] }, diagnostics: [] });

/** `replace` lands in place; `insertBefore`/`insertAfter` splice at one offset. */
const rangeFor = (
  span: SourceSpan,
  action: Exclude<BlockAction, "delete">,
): { from: number; to: number } =>
  action === "replace"
    ? { from: span.start, to: span.end }
    : action === "insertBefore"
      ? { from: span.start, to: span.start }
      : { from: span.end, to: span.end };

export const applyBlockPatch = (html: string, request: BlockPatchRequest): BlockPatchOutcome => {
  if (!isBlockAction(request.action)) {
    const action: unknown = request.action;
    // Stryker disable next-line StringLiteral: the contract pins the code, not the wording.
    throw new HrError("invalid_input", `未知 action：${String(action)}`);
  }
  const fragmentRequest = fragmentRequestOf(request);
  const parsed = parseHtml(html, { locations: true });
  const located = locateBlock(parsed, request.address, html);
  if (!located.ok) throw locateError(request.address, located.code);
  const span = located.entry.range;
  // D68: both oracles judge the raw parse5 tree — the DOM the bytes actually build —
  // once per scripting mode. The block's raw twin shares its source extent; a listed
  // block with no raw twin in either mode cannot be verified against the real DOM.
  const rawOff = parseRawHtml(html, false);
  const rawOn = parseRawHtml(html, true);
  const slotOff = findRawSlot(rawOff, span);
  const slotOn = findRawSlot(rawOn, span);
  if (slotOff === undefined || slotOn === undefined) {
    // Stryker disable next-line StringLiteral: locateError narrows any non-"invalid_selector"
    // argument to the same target_moved error — the call-site literal is contract-pinned.
    throw locateError(request.address, "target_moved");
  }
  // D60: listing stays heuristic — the oracle is the construction-level guarantee.
  // The write may proceed only when removing the block's node is exactly what
  // re-parsing the byte-splice produces, in BOTH scripting modes.
  const stripped = `${html.slice(0, span.start)}${html.slice(span.end)}`;
  if (
    !rangeIsExactlyOwned(rawOff, parseRawHtml(stripped, false), slotOff) ||
    !rangeIsExactlyOwned(rawOn, parseRawHtml(stripped, true), slotOn)
  ) {
    // Stryker disable next-line StringLiteral: locateError narrows any non-"invalid_selector"
    // argument to the same target_moved error — the call-site literal is contract-pinned.
    throw locateError(request.address, "target_moved");
  }
  if (fragmentRequest.action === "delete") {
    const next = stripped;
    return {
      html: next,
      newIds: [],
      replacedIds: [],
      warnings: [],
      // A degenerate range removes nothing: report unchanged so no snapshot or write happens.
      changed: next.length !== html.length,
      address: undefined,
    };
  }
  const {
    root: fragment,
    warnings,
    rootId: fragmentRootId,
  } = parseFragmentWithDiagnostics(fragmentRequest.html);
  const parent = parentElementOf(parsed.root, located.entry.node);
  if (parent !== undefined) assertFragmentFits(parent, fragment);
  const text = fragmentText(fragment);
  const { from, to } = rangeFor(span, fragmentRequest.action);
  // An equal replace never touches disk: identical bytes mean no "change" to record (same as `applyPatch`'s sameContent branch).
  if (fragmentRequest.action === "replace" && html.slice(from, to) === text) {
    return {
      html,
      newIds: [],
      replacedIds: [],
      warnings: [],
      changed: false,
      address: formatAddress(located.entry),
    };
  }
  const next = `${html.slice(0, from)}${text}${html.slice(to)}`;
  // D64: the splice oracle covers only what the write REMOVES — the result must also
  // re-parse into the block's context or nothing is written. Judged on the raw trees
  // of both scripting modes, with the fragment's top-level raw nodes at the slot.
  if (
    !writeKeepsContext(
      rawOff,
      parseRawHtml(next, false),
      slotOff,
      parseRawFragmentNodes(text, false),
      fragmentRequest.action,
    ) ||
    !writeKeepsContext(
      rawOn,
      parseRawHtml(next, true),
      slotOn,
      parseRawFragmentNodes(text, true),
      fragmentRequest.action,
    )
  ) {
    // Stryker disable next-line StringLiteral: locateError narrows any non-"invalid_selector"
    // argument to the same target_moved error — the call-site literal is contract-pinned.
    throw locateError(request.address, "target_moved");
  }
  return {
    html: next,
    newIds: [],
    replacedIds: [],
    warnings: [...warnings, ...fragmentIdWarnings(fragmentRootId, undefined)],
    changed: true,
    address: firstBlockAddressIn(next, from, from + text.length),
  };
};
