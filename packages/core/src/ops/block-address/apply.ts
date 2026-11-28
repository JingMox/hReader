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
// Both compare trees node-by-node modulo the implicit html/head/body scaffold, so an
// empty splice is an empty body — and on any divergence nothing is written. No IO, no
// id injection: foreign files never grow `data-hr-id`s.

import type { HtmlAttribute, HtmlElementNode, HtmlNode, SourceSpan } from "../../html/constants";
import { parseHtml } from "../../html/parse";
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

/**
 * Ordered attribute-pair equality — the parser keeps source attr order on both sides.
 * `\0` can never appear in a parsed name or value, so the joined encoding is exact.
 */
const sameAttrs = (left: readonly HtmlAttribute[], right: readonly HtmlAttribute[]): boolean =>
  left.map((attr) => `${attr[0]}\0${attr[1]}`).join("\0") ===
  right.map((attr) => `${attr[0]}\0${attr[1]}`).join("\0");

/**
 * Adjacent text siblings folded into one run — a tree surgery can leave two text nodes
 * side by side where re-parsing produces a single merged one (an element's "own direct
 * text" is the concatenation either way). Comments still break runs.
 */
const textMerged = (children: readonly HtmlNode[]): readonly HtmlNode[] => {
  const merged: HtmlNode[] = [];
  for (const child of children) {
    const last = merged[merged.length - 1];
    if (child.kind === "text" && last?.kind === "text") {
      merged[merged.length - 1] = { ...last, value: last.value + child.value };
    } else {
      merged.push(child);
    }
  }
  return merged;
};

const sameNodeList = (left: readonly HtmlNode[], right: readonly HtmlNode[]): boolean => {
  const a = textMerged(left);
  const b = textMerged(right);
  return (
    a.length === b.length &&
    a.every((node, index) => {
      const other = b[index];
      return other !== undefined && sameShape(node, other);
    })
  );
};

/**
 * Node-by-node tree equality — kind, tag, attrs, payloads, children. Spans are ignored.
 * The `as` casts narrow `right` to `left`'s kind, which the first guard proved equal.
 */
const sameShape = (left: HtmlNode, right: HtmlNode): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === "element") {
    const other = right as HtmlElementNode;
    return (
      left.tag === other.tag &&
      sameAttrs(left.attrs, other.attrs) &&
      sameNodeList(left.children, other.children)
    );
  }
  // Documents only ever compare through `sameDocument`, which peels them first — this
  // arm keeps the kind union total and is unreachable in practice.
  /* v8 ignore next */
  if (left.kind === "document") return sameNodeList(left.children, (right as typeof left).children);
  if (left.kind === "text") return left.value === (right as typeof left).value;
  // A reached comment is an atomic node from the same bytes on both sides — provably equal.
  /* v8 ignore next */
  if (left.kind === "comment") return left.data === (right as typeof left).data;
  const other = right as typeof left;
  // A reached doctype comes from the same bytes on both sides — the fields are provably equal.
  /* v8 ignore start */
  return (
    left.name === other.name && left.publicId === other.publicId && left.systemId === other.systemId
  );
  /* v8 ignore stop */
};

/**
 * `root` split into comparable parts by peeling the implicit `html/head/body` scaffold:
 * a splice can legitimately re-parse to a bare `document` (`""`) or to a tree carrying
 * the scaffold the parser synthesized — the scaffold itself is not content. `rest`
 * keeps every document child outside `<html>` (doctype, stray nodes) for a strict check.
 */
interface ScaffoldParts {
  readonly head: readonly HtmlNode[];
  readonly body: readonly HtmlNode[];
  readonly rest: readonly HtmlNode[];
}

const scaffoldPartsOf = (root: HtmlNode): ScaffoldParts => {
  // The oracles only ever compare whole documents; the fallback would matter only for
  // a root that is not a document.
  /* v8 ignore start */
  const children = root.kind === "document" ? root.children : [root];
  /* v8 ignore stop */
  const head: HtmlNode[] = [];
  const body: HtmlNode[] = [];
  const rest: HtmlNode[] = [];
  for (const child of children) {
    if (child.kind === "element" && child.tag === "html") {
      for (const inner of child.children) {
        // parse5 wraps stray nodes into body; html keeps only head/body children.
        /* v8 ignore start */
        if (inner.kind !== "element" || (inner.tag !== "head" && inner.tag !== "body")) {
          rest.push(inner);
          continue;
        }
        /* v8 ignore stop */
        if (inner.tag === "head") head.push(...inner.children);
        else body.push(...inner.children);
      }
    } else {
      rest.push(child);
    }
  }
  return { head, body, rest };
};

/** Whole-document comparison modulo the implicit scaffold — what both oracles share. */
const sameDocument = (left: HtmlNode, right: HtmlNode): boolean => {
  const a = scaffoldPartsOf(left);
  const b = scaffoldPartsOf(right);
  return (
    sameNodeList(a.head, b.head) && sameNodeList(a.body, b.body) && sameNodeList(a.rest, b.rest)
  );
};

/**
 * `root` with `insert` spliced at `cut`'s slot per `action` — replacing `cut`, or before /
 * after it — the spine is rebuilt, the rest shared. Deleting `cut` is `insert: []`.
 */
const treeSpliced = (
  root: HtmlNode,
  cut: HtmlNode,
  insert: readonly HtmlNode[],
  action: "replace" | "insertBefore" | "insertAfter",
): HtmlNode => {
  if (root.kind !== "element" && root.kind !== "document") return root;
  return {
    ...root,
    children: root.children.flatMap((child) => {
      if (child !== cut) return [treeSpliced(child, cut, insert, action)];
      if (action === "insertBefore") return [...insert, child];
      if (action === "insertAfter") return [child, ...insert];
      return [...insert];
    }),
  };
};

/** `root` with `cut` spliced out of its parent's children — a `replace` with nothing. */
const treeWithout = (root: HtmlNode, cut: HtmlNode): HtmlNode =>
  treeSpliced(root, cut, [], "replace");

/**
 * The D60 pre-write oracle — what the splice REMOVES is guaranteed by it. Removing the
 * block's node from the parse tree and re-parsing the byte-splice must produce the same
 * document (modulo the implicit scaffold): a leftover foreign byte (an ignored tag,
 * fostered content, dropped markup) makes the two sides diverge, so the range is not
 * exactly owned and nothing is written.
 */
const rangeIsExactlyOwned = (
  html: string,
  root: HtmlNode,
  node: HtmlNode,
  range: SourceSpan,
): boolean =>
  sameDocument(
    parseHtml(`${html.slice(0, range.start)}${html.slice(range.end)}`).root,
    treeWithout(root, node),
  );

/**
 * The D64 post-write oracle — what the splice ADDS is guaranteed by it. The written
 * result is re-parsed and compared node-by-node against the expected tree, which is the
 * original tree with the fragment spliced at the block's slot under its original parent:
 * replacing the block, or immediately before/after it. Scope-close (li/dd/dt/button),
 * adoption-agency (a/nobr), nested-form and foreign-content (svg/math) breakouts all
 * reparent or drop nodes, and unclosed raw text swallows the fragment — any such
 * divergence means the write would land outside its promised context → nothing written.
 */
const writeKeepsContext = (
  original: HtmlNode,
  result: string,
  node: HtmlNode,
  fragment: HtmlNode,
  action: "replace" | "insertBefore" | "insertAfter",
): boolean => sameDocument(treeSpliced(original, node, [fragment], action), parseHtml(result).root);

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
  // D60: listing stays heuristic — the oracle is the construction-level guarantee.
  // The write may proceed only when removing the block's node is exactly what
  // re-parsing the byte-splice produces; anything else means the range hid unowned
  // bytes, and nothing is written.
  if (!rangeIsExactlyOwned(html, parsed.root, located.entry.node, span)) {
    // Stryker disable next-line StringLiteral: locateError narrows any non-"invalid_selector"
    // argument to the same target_moved error — the call-site literal is contract-pinned.
    throw locateError(request.address, "target_moved");
  }
  if (fragmentRequest.action === "delete") {
    const next = `${html.slice(0, span.start)}${html.slice(span.end)}`;
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
  // re-parse into the block's context or nothing is written.
  if (!writeKeepsContext(parsed.root, next, located.entry.node, fragment, fragmentRequest.action)) {
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
