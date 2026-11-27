// This layer covers the property contract over generated HTML: every listed address resolves
// back to its own block, replace leaves bytes outside the target range untouched, and
// listBlocks is deterministic.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyBlockPatch,
  listBlocks,
  resolveAddress,
  type BlockPatchOutcome,
} from "../src/ops/block-address";
import type { BlockPatchRequest } from "../src/ops/block-address";

/**
 * The generated trees can put a block under a parent whose content model rejects its tag
 * (e.g. `<dl><p>` — parse5 keeps it, `assertFragmentFits` refuses). A refusal is the gate
 * doing its job, not a splice defect: skip that case, assert the rest.
 */
const patchOrSkip = (html: string, request: BlockPatchRequest): BlockPatchOutcome | undefined => {
  try {
    return applyBlockPatch(html, request);
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "content_model_conflict") return undefined;
    throw error;
  }
};

const LEAF_TAGS = ["p", "h1", "h2", "li", "pre", "blockquote", "dt", "dd", "figcaption"];
const CONTAINER_TAGS = ["div", "section", "article", "ul", "ol", "dl", "header", "aside"];

/** Text content with HTML-significant chars entity-escaped so any tree stays valid. */
const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

interface GenNode {
  readonly tag: string;
  readonly text: string | undefined;
  readonly children: readonly GenNode[];
}

const leafArb: fc.Arbitrary<GenNode> = fc.record({
  tag: fc.constantFrom(...LEAF_TAGS),
  text: fc.string({ maxLength: 24 }),
  children: fc.constant([] as readonly GenNode[]),
});

const { node: treeArb } = fc.letrec<{ node: GenNode }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    leafArb,
    fc.record({
      tag: fc.constantFrom(...CONTAINER_TAGS),
      text: fc.constant(undefined as string | undefined),
      children: fc.array(tie("node"), { maxLength: 4 }),
    }),
  ),
}));

const render = (node: GenNode): string => {
  const inner =
    node.text !== undefined ? escapeText(node.text) : node.children.map(render).join("");
  return `<${node.tag}>${inner}</${node.tag}>`;
};

const docArb: fc.Arbitrary<string> = fc
  .array(treeArb, { minLength: 1, maxLength: 5 })
  .map((nodes) => `<!DOCTYPE html><html><body>${nodes.map(render).join("")}</body></html>`);

const RUNS = { numRuns: 40 };

describe("property · generated HTML", () => {
  it("should resolve every listed address back to the same block", () => {
    fc.assert(
      fc.property(docArb, (html) => {
        for (const block of listBlocks(html)) {
          const resolved = resolveAddress(html, block.address);
          expect(resolved).toEqual({ ok: true, block });
          expect(html.slice(block.start, block.end)).toContain(`<${block.tag}`);
        }
      }),
      RUNS,
    );
  });

  it("should keep every byte outside the replaced range unchanged", () => {
    fc.assert(
      fc.property(docArb, fc.string({ maxLength: 12 }), (html, text) => {
        const [block] = listBlocks(html);
        if (block === undefined) return;
        // Same-tag fragment: fits the parent's content model whenever the model allows the
        // block at all; the refused cases are skipped inside patchOrSkip.
        const outcome = patchOrSkip(html, {
          address: block.address,
          action: "replace",
          html: `<${block.tag}>${escapeText(text)}</${block.tag}>`,
        });
        if (outcome === undefined) return;
        expect(outcome.html.slice(0, block.start)).toBe(html.slice(0, block.start));
        expect(outcome.html.endsWith(html.slice(block.end))).toBe(true);
      }),
      RUNS,
    );
  });

  it("should produce identical listBlocks output on a re-list", () => {
    fc.assert(
      fc.property(docArb, (html) => {
        expect(listBlocks(html)).toEqual(listBlocks(html));
      }),
      RUNS,
    );
  });

  it("should keep every byte outside an inserted fragment unchanged", () => {
    fc.assert(
      fc.property(docArb, fc.string({ maxLength: 12 }), (html, text) => {
        const [block] = listBlocks(html);
        if (block === undefined) return;
        const outcome = patchOrSkip(html, {
          address: block.address,
          action: "insertAfter",
          html: `<${block.tag}>${escapeText(text)}</${block.tag}>`,
        });
        if (outcome === undefined) return;
        expect(outcome.html.slice(0, block.end)).toBe(html.slice(0, block.end));
        expect(outcome.html.endsWith(html.slice(block.end))).toBe(true);
      }),
      RUNS,
    );
  });
});
