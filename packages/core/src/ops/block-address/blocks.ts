// This layer: leaf-block discovery. A leaf block's tag is in `BLOCK_ADDRESS_TAGS` and its
// subtree holds no other block-set element. Each entry carries the canonical selector path
// (`body > tag:nth-of-type(n) > …`) and the text fingerprint — the two halves of an address.
// Pure: no IO, no clock.

import { TEXT_SKIP_TAGS } from "../../annotations/body-text";
import { SELECTOR_LIMITS, type SelectorStep } from "../../annotations/relocate";
import type { HtmlElementNode, HtmlNode, SourceSpan } from "../../html/constants";
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
 * Whether `steps` can ever be written as a parseable selector path. `parseSelectorPath`
 * rejects nth-of-type > `SELECTOR_LIMITS.nth`, more than `steps` steps and over-`chars`
 * paths — a block whose canonical path overflows any bound would mint an address that
 * resolves to nothing, so it is not a block (same family as non-leaf containers).
 */
const expressibleSteps = (steps: readonly SelectorStep[]): boolean => {
  if (steps.length > SELECTOR_LIMITS.steps) return false;
  let chars = 0;
  for (const step of steps) {
    if (step.nth > SELECTOR_LIMITS.nth) return false;
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

const entryOf = (chain: Chain, steps: readonly SelectorStep[]): BlockEntry => {
  const text = blockTextOf(chain.node);
  return {
    node: chain.node,
    steps,
    text,
    fingerprint: sha1Hex(text).slice(0, FINGERPRINT_CHARS),
  };
};

/**
 * All leaf blocks in document order. Two passes over the tree (post-order "has a block
 * descendant" map, then pre-order chain walk) keep it O(tree) instead of re-scanning each
 * candidate's subtree.
 */
export const collectBlocks = (root: HtmlNode): readonly BlockEntry[] => {
  const inside = blockInsideOf(root);
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
        const steps = stepsOf(root, own);
        if (expressibleSteps(steps)) {
          entries.push(entryOf(own, steps));
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

const spanOf = (node: HtmlElementNode): SourceSpan => ({ ...ZERO_SPAN, ...node.span });

const stepText = (step: SelectorStep): string =>
  step.nth === 1 ? step.tag : `${step.tag}:nth-of-type(${String(step.nth)})`;

export const formatAddress = (entry: BlockEntry): string =>
  `${ADDRESS_PREFIX}${entry.steps.map(stepText).join(" > ")}@${entry.fingerprint}`;

export const infoOf = (entry: BlockEntry): BlockInfo => ({
  address: formatAddress(entry),
  tag: entry.node.tag,
  textPreview: truncate(entry.text, PREVIEW_CHARS),
  start: spanOf(entry.node).start,
  end: spanOf(entry.node).end,
});

/** Document-order list of every addressable leaf block with its source byte range. */
export const listBlocks = (html: string): readonly BlockInfo[] =>
  collectBlocks(parseHtml(html, { locations: true }).root).map(infoOf);
