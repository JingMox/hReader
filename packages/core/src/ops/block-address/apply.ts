// This layer: the pure byte splice behind `patchBlock`. It resolves the address on the exact
// bytes it rewrites, validates the fragment through the managed-document pipeline
// (`fragment.ts` checks + the content-model gate), then replaces only the block's outerHTML
// range — every other byte is untouched. Block listing is heuristic, so a listed range may
// still hide unowned bytes: the D60 oracle (`rangeIsExactlyOwned`) re-parses the byte-splice
// and writes only when it is provably the original tree minus the block — patching is
// guaranteed by construction, listing is not. No IO, no id injection: foreign files never
// grow `data-hr-id`s.

import type { HtmlNode, SourceSpan } from "../../html/constants";
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

/** `root` with `cut` spliced out of its parent's children — the spine is rebuilt, the rest shared. */
const treeWithout = (root: HtmlNode, cut: HtmlNode): HtmlNode => {
  if (root.kind !== "element" && root.kind !== "document") return root;
  return {
    ...root,
    children: root.children
      .filter((child) => child !== cut)
      .map((child) => treeWithout(child, cut)),
  };
};

/**
 * The D60 patch-time oracle — listing is heuristic; this is the guarantee. Removing the
 * block's node from the parse tree and re-parsing the byte-splice must produce the same
 * document: a leftover foreign byte (an ignored tag, fostered content, dropped markup)
 * makes the two sides diverge, so the range is not exactly owned and nothing is written.
 * `insertBefore`/`insertAfter` splice at the range boundaries, so the same check
 * validates all four actions.
 */
const rangeIsExactlyOwned = (
  html: string,
  root: HtmlNode,
  node: HtmlNode,
  range: SourceSpan,
): boolean =>
  serializeHtml(parseHtml(`${html.slice(0, range.start)}${html.slice(range.end)}`)) ===
  // Stryker disable next-line ArrayDeclaration: serializeHtml reads only `root`.
  serializeHtml({ root: treeWithout(root, node), diagnostics: [] });

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
  return {
    html: next,
    newIds: [],
    replacedIds: [],
    warnings: [...warnings, ...fragmentIdWarnings(fragmentRootId, undefined)],
    changed: true,
    address: firstBlockAddressIn(next, from, from + text.length),
  };
};
