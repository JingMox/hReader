// This layer: leaf-block discovery. A leaf block's tag is in `BLOCK_ADDRESS_TAGS` and its
// subtree holds no other block-set element. Each entry carries the canonical selector path
// (`body > tag:nth-of-type(n) > …`) and the text fingerprint — the two halves of an address.
// Pure: no IO, no clock.

import { TEXT_SKIP_TAGS } from "../../annotations/body-text";
import { SELECTOR_LIMITS, type SelectorStep } from "../../annotations/relocate";
import {
  RAW_TEXT_TAGS,
  RCDATA_TAGS,
  type HtmlElementNode,
  type HtmlNode,
  type SourceSpan,
} from "../../html/constants";
import { parseHtml } from "../../html/parse";
import { ZERO_SPAN } from "../../html/span";
import { drainStack } from "../../html/stack";
import { normalizeWhitespace } from "../../html/text";
import { sha1Hex } from "../../io/digest";
import { truncate } from "../outline/text";
import { ADDRESS_PREFIX, BLOCK_ADDRESS_TAGS, FINGERPRINT_CHARS, PREVIEW_CHARS } from "./constants";
import type { BlockInfo } from "./constants";

/**
 * One addressable element plus everything needed to mint or match its address.
 * `steps` is the canonical selector path (the same `SelectorStep` shape `elementByPath` walks).
 */
export interface BlockEntry {
  readonly node: HtmlElementNode;
  readonly steps: readonly SelectorStep[];
  /** The body-text-domain text, whitespace-collapsed and trimmed — basis of both fingerprint and preview. */
  readonly text: string;
  readonly fingerprint: string;
  /** The byte range a patch may touch — the element's own subtree only (see `ownedRangeOf`). */
  readonly range: SourceSpan;
}

/** `Chain` is a persistent (linked) ancestor list: O(1) per element even on very deep trees. */
interface Chain {
  readonly up: Chain | undefined;
  readonly node: HtmlElementNode;
}

const childNodesOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "element" || node.kind === "document" ? node.children : [];

const pushReversed = (children: readonly HtmlNode[], stack: HtmlNode[]): void => {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) stack.push(child);
  }
};

/**
 * Post-order pass: for every element, whether its subtree below it holds a block-tag element.
 * A `<div><span><p>` chain marks the div non-leaf — descendants through inline wrappers count.
 */
const blockInsideOf = (root: HtmlNode): ReadonlyMap<HtmlElementNode, boolean> => {
  const inside = new Map<HtmlElementNode, boolean>();
  const pending: { readonly node: HtmlNode; readonly childrenDone: boolean }[] = [
    { node: root, childrenDone: false },
  ];
  for (;;) {
    const frame = pending.pop();
    // Loop control already guarantees a frame; `undefined` is only `Array#pop`'s signature.
    /* v8 ignore next */
    if (frame === undefined) break;
    const children = childNodesOf(frame.node);
    if (!frame.childrenDone) {
      pending.push({ node: frame.node, childrenDone: true });
      // equivalent — an overshooting index reads undefined, which the guard below skips.
      // Stryker disable next-line ArithmeticOperator
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) pending.push({ node: child, childrenDone: false });
      }
      continue;
    }
    if (frame.node.kind !== "element") continue;
    let has = false;
    for (const child of children) {
      if (
        child.kind === "element" &&
        (BLOCK_ADDRESS_TAGS.has(child.tag) || inside.get(child) === true)
      ) {
        has = true;
        break;
      }
    }
    inside.set(frame.node, has);
  }
  return inside;
};

/** The element's 1-based index among the same-tag element siblings of `children`. */
const nthOfType = (children: readonly HtmlNode[], node: HtmlElementNode): number => {
  let nth = 0;
  for (const child of children) {
    if (child.kind !== "element" || child.tag !== node.tag) continue;
    nth += 1;
    if (child === node) return nth;
    // The node is always among `children` (the caller iterates a real ancestor chain);
    // the loop-exit edge is unreachable.
    /* v8 ignore start */
  }
  return nth;
};
/* v8 ignore stop */

/**
 * Canonical path steps for a leaf block. Anchored at `body` — the same grammar
 * `parseSelectorPath` reads (`elementByPath` resolves step 0 document-wide, so `body`
 * self-anchors). parse5 always places content under `body`, so the no-body fallback is
 * unreachable for real parses.
 */
const stepsOf = (root: HtmlNode, chain: Chain): readonly SelectorStep[] => {
  const ancestors: HtmlElementNode[] = [];
  for (let link: Chain | undefined = chain; link !== undefined; link = link.up) {
    ancestors.push(link.node);
  }
  ancestors.reverse();
  const bodyIndex = ancestors.findIndex((element) => element.tag === "body");
  /* v8 ignore next — parse5 always materializes body: a content element in a non-empty document cannot lack a body ancestor */
  const first = bodyIndex < 0 ? 0 : bodyIndex;
  const steps: SelectorStep[] = [];
  for (let index = first; index < ancestors.length; index += 1) {
    const node = ancestors[index];
    /* v8 ignore next — an in-bounds index always yields a node */
    if (node === undefined) continue;
    /* v8 ignore start — same reason as bodyIndex: body always has an html ancestor, so index===0 is unreachable */
    const parent = index === 0 ? undefined : ancestors[index - 1];
    const siblings = parent === undefined ? childNodesOf(root) : parent.children;
    /* v8 ignore stop */
    steps.push({ tag: node.tag, nth: nthOfType(siblings, node) });
  }
  return steps;
};

/**
 * The selector grammar's tag name — `NAME_START` then `NAME_CHAR`s from relocate.ts.
 * parse5 accepts almost anything as a tag name (`d[i`, `d"i`, `d<i`, `x:y`), but a
 * step text outside the grammar can never parse back — the minted address would be
 * unresolvable, so the block must not be listed (D64).
 */
const EXPRESSIBLE_TAG = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Whether `steps` can ever be written as a parseable selector path. `parseSelectorPath`
 * rejects nth-of-type > `SELECTOR_LIMITS.nth`, more than `steps` steps, over-`chars`
 * paths and names outside its grammar — a block whose canonical path hits any of those
 * would mint an address that resolves to nothing, so it is not a block (same family as
 * non-leaf containers).
 */
const expressibleSteps = (steps: readonly SelectorStep[]): boolean => {
  if (steps.length > SELECTOR_LIMITS.steps) return false;
  let chars = 0;
  for (const step of steps) {
    if (!EXPRESSIBLE_TAG.test(step.tag) || step.nth > SELECTOR_LIMITS.nth) return false;
    chars += stepText(step).length + 3; // " > " separator budget (exact join cost ≤ this)
  }
  return chars - 3 <= SELECTOR_LIMITS.chars;
};

/**
 * The block's text in the `bodyTextOf` domain: descendant text nodes in document order,
 * minus `script`/`style`/`template`/`noscript` subtrees — then whitespace-collapsed and
 * trimmed. A block nested inside a skipped subtree still keeps its own text.
 *
 * Read on the default scripting-off tree (no `scriptingEnabled`): patching works on source
 * structure, where `<noscript>` children are real elements — a `<p>` inside `<noscript>`
 * stays addressable and byte-patchable. The scripting-on tree (D54, annotation body-text
 * only) reads them as raw text and would hide them from addressing; the skip rules hash a
 * noscript subtree identically under both modes, so fingerprints stay in one domain.
 */
const blockTextOf = (node: HtmlElementNode): string => {
  const parts: string[] = [];
  // A bogus stack entry pops to a non-node whose `kind` is undefined — the kind checks
  // below skip it identically.
  // Stryker disable next-line ArrayDeclaration
  const stack: HtmlNode[] = [];
  pushReversed(node.children, stack);
  for (const current of drainStack(stack)) {
    if (current.kind === "text") {
      parts.push(current.value);
      continue;
    }
    if (current.kind !== "element" || TEXT_SKIP_TAGS.has(current.tag)) continue;
    pushReversed(current.children, stack);
  }
  return normalizeWhitespace(parts.join(""));
};

interface OwnedLeaf {
  readonly start: number;
  readonly end: number;
  readonly node: HtmlNode;
}

/**
 * The doc-wide table `ownedRangeOf` validates a candidate range against: every located
 * text/comment leaf. Built once per `collectBlocks` pass — fostered leaves arrive out
 * of source order, so the list is sorted by start for a binary-search entry point.
 * Tag ownership needs no table: a member's own tag ranges are skipped ranges in the
 * byte scan, so any tag-shaped byte left over is foreign or ignored — both disqualify.
 */
const leafIndexOf = (root: HtmlNode): readonly OwnedLeaf[] => {
  const leaves: OwnedLeaf[] = [];
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind === "element" || node.kind === "document") {
      pushReversed(node.children, stack);
      continue;
    }
    if (node.kind === "text" || node.kind === "comment") {
      /* v8 ignore next — under locations:true every source leaf carries a span */
      if (node.span !== undefined) {
        leaves.push({ start: node.span.start, end: node.span.end, node });
      }
    }
  }
  leaves.sort((a, b) => a.start - b.start);
  return leaves;
};

/** First index in `leaves` whose start is `>= at` — the leaves array is sorted by start. */
const firstLeafAt = (leaves: readonly OwnedLeaf[], at: number): number => {
  let lo = 0;
  let hi = leaves.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const leaf = leaves[mid];
    /* v8 ignore next — `mid < hi <= leaves.length`: an in-bounds index always yields a leaf */
    if (leaf !== undefined && leaf.start < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const isAsciiLetter = (char: string | undefined): boolean =>
  char !== undefined && ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z"));

/**
 * The range a patch may write over — only when every byte in `[span.start, span.end)` is
 * provably the block's own (D58 source-ownership validation: when unsure, do not list).
 * parse5 stretches unclosed elements past ignored end tags, synthesized ancestors carry
 * truncated spans, and fostered content lands inside ranges — none of those bytes can be
 * trusted to a splice, so the candidate range must prove its contents instead:
 *   - the element needs a real start tag (`start < innerStart`; synthesized nodes and
 *     implicit-close split pieces carry a content range and are never listed),
 *   - no tag-shaped byte may appear outside the subtree's own tag ranges — every member
 *     tag is a skipped range, so a leftover `<`+letter, `</` or `<!` is a foreign tag,
 *     an ignored tag (`<body>`, `</>`, stray `</body>`), or dropped bytes with no node
 *     (an ignored `<!DOCTYPE` folds into a leaf's span without ever creating one),
 *   - every located text/comment leaf overlapping the range belongs to the subtree —
 *     fostered-out content and foreign comments (`<!</…`, `</x` bogus comments) fail.
 *     Leaf spans are disjoint, so a leaf straddling `start` is always the predecessor
 *     of the first in-range leaf — fostered text merges into that earlier leaf.
 * The subtree's own tag ranges, comments and raw-text/RCDATA text are skipped ranges in
 * the scan: `</` inside an attribute value or a `<script>` body is content, not markup.
 */
const ownedRangeOf = (
  node: HtmlElementNode,
  leaves: readonly OwnedLeaf[],
  html: string,
): SourceSpan | undefined => {
  const span = { ...ZERO_SPAN, ...node.span };
  // Template-content elements carry a degenerate span — `end === start` while the start
  // tag itself sits at `[start, innerStart)` past `end` — so `end > start` and
  // `innerStart <= end` are checked separately from the content-range gate.
  if (span.start >= span.innerStart) return undefined;
  if (span.end <= span.start || span.innerStart > span.end) return undefined;
  const members = new Set<HtmlNode>();
  const skips: (readonly [number, number])[] = [];
  const stack: HtmlNode[] = [node];
  for (const current of drainStack(stack)) {
    members.add(current);
    if (current.kind === "element") {
      const own = { ...ZERO_SPAN, ...current.span };
      // A member without source tags pushes a zero-width `[s, s)` range — a no-op the
      // scan's advance loop drops immediately; pushing it unconditionally is identical.
      skips.push([own.start, own.innerStart], [own.innerEnd, own.end]);
      if (RAW_TEXT_TAGS.has(current.tag) || RCDATA_TAGS.has(current.tag)) {
        for (const child of current.children) {
          /* v8 ignore next — raw-text/RCDATA children are always located text nodes */
          if (child.kind === "text" && child.span !== undefined) {
            skips.push([child.span.start, child.span.end]);
          }
        }
      }
      pushReversed(current.children, stack);
      continue;
    }
    if (current.kind === "comment") {
      /* v8 ignore next — under locations:true every source leaf carries a span */
      if (current.span !== undefined) skips.push([current.span.start, current.span.end]);
    }
  }
  const { start, end } = span;
  // The tag-byte scan runs before the leaf check: a foreign comment inside the range
  // surfaces as `<!` here and as a foreign leaf there — either way disqualifies.
  skips.sort((a, b) => a[0] - b[0]);
  let skip = 0;
  for (let at = start; at < end; at += 1) {
    let covering = skips[skip];
    while (covering !== undefined && covering[1] <= at) {
      skip += 1;
      covering = skips[skip];
    }
    if (covering !== undefined && covering[0] <= at) {
      at = covering[1] - 1;
      continue;
    }
    if (html[at] !== "<") continue;
    const next = html[at + 1];
    // `<` + letter starts a tag, `</` an end tag or dropped bytes, `<!` a doctype or
    // markup declaration — an ignored `<!` produces no node at all, so its bytes are
    // markup no member owns (member tags are skipped above, member comments are skip
    // ranges). `<?` bytes are always a comment leaf, covered by the leaf check; a
    // stray `<` in text is owned content.
    if (isAsciiLetter(next) || next === "/" || next === "!") return undefined;
  }
  // The first leaf at-or-after `start` misses a leaf that began earlier and straddles
  // into the range: fostered text merges into the preceding leaf, whose span then
  // covers the block's start tag. Leaf spans are disjoint, so the predecessor index
  // is the only earlier leaf that can overlap.
  for (let at = Math.max(0, firstLeafAt(leaves, start) - 1); ; at += 1) {
    const leaf = leaves[at];
    if (leaf === undefined || leaf.start >= end) break;
    if (leaf.end <= start) continue;
    if (!members.has(leaf.node)) return undefined;
  }
  return span;
};

const entryOf = (chain: Chain, steps: readonly SelectorStep[], range: SourceSpan): BlockEntry => {
  const text = blockTextOf(chain.node);
  return {
    node: chain.node,
    steps,
    text,
    fingerprint: sha1Hex(text).slice(0, FINGERPRINT_CHARS),
    range,
  };
};

/**
 * All leaf blocks in document order, ranges validated against `html` (D58 ownership).
 * Three passes over the tree — the "has a block descendant" map, the ownership index,
 * then the pre-order chain walk — keep it O(tree + range bytes) per pass.
 */
export const collectBlocks = (root: HtmlNode, html: string): readonly BlockEntry[] => {
  const inside = blockInsideOf(root);
  const leaves = leafIndexOf(root);
  const entries: BlockEntry[] = [];
  const stack: { readonly node: HtmlNode; readonly chain: Chain | undefined }[] = [
    { node: root, chain: undefined },
  ];
  for (const frame of drainStack(stack)) {
    const node = frame.node;
    if (node.kind !== "element" && node.kind !== "document") continue;
    const own: Chain | undefined =
      node.kind === "element" ? { up: frame.chain, node } : frame.chain;
    if (node.kind === "element" && BLOCK_ADDRESS_TAGS.has(node.tag) && inside.get(node) !== true) {
      /* v8 ignore next — the element branch just assigned `own` */
      if (own !== undefined) {
        const range = ownedRangeOf(own.node, leaves, html);
        const steps = stepsOf(root, own);
        if (range !== undefined && expressibleSteps(steps)) {
          entries.push(entryOf(own, steps, range));
        }
      }
    }
    // equivalent — an overshooting index reads undefined, which the guard below already skips.
    // Stryker disable next-line ArithmeticOperator
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push({ node: child, chain: own });
    }
  }
  return entries;
};

const stepText = (step: SelectorStep): string =>
  step.nth === 1 ? step.tag : `${step.tag}:nth-of-type(${String(step.nth)})`;

export const formatAddress = (entry: BlockEntry): string =>
  `${ADDRESS_PREFIX}${entry.steps.map(stepText).join(" > ")}@${entry.fingerprint}`;

export const infoOf = (entry: BlockEntry): BlockInfo => ({
  address: formatAddress(entry),
  tag: entry.node.tag,
  textPreview: truncate(entry.text, PREVIEW_CHARS),
  start: entry.range.start,
  end: entry.range.end,
});

/** Document-order list of every addressable leaf block with its source byte range. */
export const listBlocks = (html: string): readonly BlockInfo[] =>
  collectBlocks(parseHtml(html, { locations: true }).root, html).map(infoOf);
