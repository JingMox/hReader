// The D58 source-ownership property: over ≥2000 malformed-HTML documents (ignored end
// tags, fostered content, AAA misnesting, foreign subtrees, quirks, BOM/CRLF), every
// listed block's slice must be provably its own bytes — tag tokens owned by the
// subtree, deletes preserving outside bytes and outside source tags, replace+undo
// byte-identical. Each run patches every listed block, so one pass costs ~10⁴ whole-
// document parse+serialize cycles: far past the unit suite's 30s budget under v8
// coverage instrumentation, with no way to time it reliably (same reason the 10 MB
// checks live here — vitest.perf.config.ts gives the real wall-clock budget).

import { parse as parse5, type DefaultTreeAdapterTypes } from "parse5";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyBlockPatch,
  listBlocks,
  parseHtml,
  resolveAddress,
  serializeHtml,
  type BlockPatchOutcome,
  type BlockPatchRequest,
} from "@hreader/core";

/**
 * The generated trees can put a block under a parent whose content model rejects its tag
 * (e.g. `<dl><p>` — parse5 keeps it, `assertFragmentFits` refuses), and a malformed
 * slice can be no valid single-element fragment (`<table …></p>` carries a stray end
 * tag as a second root), and some model rejections surface as `invalid_input` (a `<p>`
 * parent cannot take `<td>`). Those refusals are the gates doing their job, not a splice
 * defect: skip those cases, assert the rest.
 */
const patchOrSkip = (html: string, request: BlockPatchRequest): BlockPatchOutcome | undefined => {
  try {
    return applyBlockPatch(html, request);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (
      code === "content_model_conflict" ||
      code === "invalid_fragment" ||
      code === "invalid_input" ||
      // The D60 oracle refuses a listed block whose byte-splice is not reparse-exact —
      // a legal outcome, never a corrupting write.
      code === "target_moved"
    ) {
      return undefined;
    }
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

type P5Node = DefaultTreeAdapterTypes.Node;
type P5Element = DefaultTreeAdapterTypes.Element;

const isP5Element = (node: P5Node): node is P5Element => "tagName" in node;

const p5ChildrenOf = (node: P5Node): readonly P5Node[] => {
  if ("childNodes" in node) return node.childNodes;
  return [];
};

/** Element tokens and skippable text ranges of a parse5 tree, by source offset. */
interface TagIndex {
  /** startTag.startOffset of every element that has one. */
  readonly starts: ReadonlySet<number>;
  /** endTag.startOffset of every element that has one. */
  readonly ends: ReadonlySet<number>;
  /** Comment and raw-text/RCDATA text ranges — `</` inside them is content, not markup. */
  readonly skips: readonly (readonly [number, number])[];
  /** (tag, startTag.startOffset) for every located element — the "source tags by offset". */
  readonly elements: readonly (readonly [string, number])[];
}

const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const RCDATA = new Set(["textarea", "title"]);

const tagIndexOf = (html: string): TagIndex => {
  const document = parse5(html, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  const starts = new Set<number>();
  const ends = new Set<number>();
  const skips: [number, number][] = [];
  const elements: [string, number][] = [];
  const walk = (node: P5Node, parentTag: string | undefined): void => {
    if (isP5Element(node)) {
      const location = node.sourceCodeLocation;
      if (location?.startTag !== undefined) {
        starts.add(location.startTag.startOffset);
        elements.push([node.tagName, location.startTag.startOffset]);
      }
      if (location?.endTag !== undefined) ends.add(location.endTag.startOffset);
      const children = "content" in node ? node.content.childNodes : p5ChildrenOf(node);
      for (const child of children) walk(child, node.tagName);
      return;
    }
    const location = node.sourceCodeLocation;
    if (location !== null && location !== undefined) {
      const range: [number, number] = [location.startOffset, location.endOffset];
      if (
        node.nodeName === "#comment" ||
        (node.nodeName === "#text" &&
          parentTag !== undefined &&
          (RAW_TEXT.has(parentTag) || RCDATA.has(parentTag)))
      ) {
        skips.push(range);
      }
    }
    for (const child of p5ChildrenOf(node)) walk(child, undefined);
  };
  walk(document, undefined);
  return { starts, ends, skips, elements };
};

/**
 * The owned tag tokens of one block, rebuilt from the parse5 tree: find the element(s)
 * whose startTag opens at `block.start` and whose location ends at `block.end`, then
 * collect their subtree's start/end tags and skippable ranges (tag internals, comments,
 * raw text). A token inside the block range outside these sets is foreign.
 */
interface OwnedIndex {
  readonly starts: ReadonlySet<number>;
  readonly ends: ReadonlySet<number>;
  readonly skips: readonly (readonly [number, number])[];
}

const ownedIndexOf = (html: string, start: number, end: number): OwnedIndex | undefined => {
  const document = parse5(html, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  const matches: P5Element[] = [];
  const find = (node: P5Node): void => {
    if (isP5Element(node)) {
      const location = node.sourceCodeLocation;
      if (location?.startTag?.startOffset === start && location.endOffset === end) {
        matches.push(node);
      }
      const children = "content" in node ? node.content.childNodes : p5ChildrenOf(node);
      for (const child of children) find(child);
      return;
    }
    for (const child of p5ChildrenOf(node)) find(child);
  };
  find(document);
  if (matches.length === 0) return undefined;
  const starts = new Set<number>();
  const ends = new Set<number>();
  const skips: [number, number][] = [];
  const collect = (node: P5Node, parentTag: string | undefined): void => {
    if (isP5Element(node)) {
      const location = node.sourceCodeLocation;
      if (location?.startTag !== undefined) {
        starts.add(location.startTag.startOffset);
        skips.push([location.startTag.startOffset, location.startTag.endOffset]);
      }
      if (location?.endTag !== undefined) {
        ends.add(location.endTag.startOffset);
        skips.push([location.endTag.startOffset, location.endTag.endOffset]);
      }
      const children = "content" in node ? node.content.childNodes : p5ChildrenOf(node);
      for (const child of children) collect(child, node.tagName);
      return;
    }
    const location = node.sourceCodeLocation;
    if (location !== null && location !== undefined) {
      const range: [number, number] = [location.startOffset, location.endOffset];
      if (
        node.nodeName === "#comment" ||
        (node.nodeName === "#text" &&
          parentTag !== undefined &&
          (RAW_TEXT.has(parentTag) || RCDATA.has(parentTag)))
      ) {
        skips.push(range);
      }
    }
    for (const child of p5ChildrenOf(node)) collect(child, undefined);
  };
  for (const match of matches) collect(match, undefined);
  return { starts, ends, skips };
};

const isAsciiLetter = (char: string | undefined): boolean =>
  char !== undefined && ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z"));

/** A tag name ends at whitespace, `/` or `>` — anything else means a longer tag name matched. */
const isTagBoundary = (char: string | undefined): boolean =>
  char !== undefined && " \t\n\r\f/>".includes(char);

/**
 * Every tag-looking token inside `[start, end)` must be owned by the block's subtree:
 * a `<name` at an owned startTag start, a `</name` at an owned endTag start, and anything
 * else that looks like markup (`<!`, `<?`, `</x`) must not appear outside skipped ranges.
 */
const everyTagTokenOwned = (
  html: string,
  index: OwnedIndex,
  start: number,
  end: number,
): boolean => {
  const sorted = [...index.skips].sort((a, b) => a[0] - b[0]);
  let skip = 0;
  for (let at = start; at < end; at += 1) {
    while (skip < sorted.length && (sorted[skip]?.[1] ?? 0) <= at) skip += 1;
    const covering = sorted[skip];
    if (covering !== undefined && covering[0] <= at && at < covering[1]) {
      at = covering[1] - 1;
      continue;
    }
    if (html[at] !== "<") continue;
    const next = html[at + 1];
    if (isAsciiLetter(next)) {
      if (!index.starts.has(at)) return false;
      continue;
    }
    if (next === "/" && isAsciiLetter(html[at + 2])) {
      if (!index.ends.has(at)) return false;
      continue;
    }
    if (next === "/" || next === "!" || next === "?") return false;
  }
  return true;
};

/** Element start-tag tokens outside `[start, end)` — the "other elements' source tags". */
const outsideTagBytes = (
  index: TagIndex,
  start: number,
  end: number,
): readonly (readonly [string, number])[] =>
  index.elements.filter(([, offset]) => offset < start || offset >= end);

const OPEN_POOL = [
  "p",
  "div",
  "li",
  "td",
  "dd",
  "option",
  "section",
  "ul",
  "table",
  "tr",
  "b",
  "i",
  "svg",
  "foreignObject",
  "math",
  "template",
  "noscript",
  "select",
  "head",
  "article",
  "pre",
  "h1",
  "figure",
  "span",
];
const CLOSE_POOL = [...OPEN_POOL, "body", "html", "thead", "tbody", "font", "caption"];

/** One malformed-HTML token: a well-formed subtree, a lone tag, stray text, or a comment-ish blob. */
const badTokenArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: treeArb.map(render) },
  { weight: 2, arbitrary: fc.constantFrom(...OPEN_POOL).map((tag) => `<${tag}>`) },
  { weight: 2, arbitrary: fc.constantFrom(...CLOSE_POOL).map((tag) => `</${tag}>`) },
  { weight: 1, arbitrary: fc.constantFrom(...OPEN_POOL).map((tag) => `<${tag} data-x="</p>">`) },
  {
    weight: 2,
    arbitrary: fc.string({ maxLength: 10 }).map((text) => escapeText(text)),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom("<!-- c -->", "<?pi x>", "<![CDATA[y]]>", "</>", "</ x>"),
  },
);

const badDocArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(badTokenArb, { minLength: 1, maxLength: 12 }),
    fc.constantFrom("", "\r\n", "\n"),
    fc.constantFrom(
      "",
      "<!DOCTYPE html>",
      "<html>",
      "<body>",
      "<html><body>",
      "<head>",
      "<head><title>t</title>",
    ),
    fc.constantFrom("", "</body>", "</body></html>", "</html>", "</head>"),
    fc.boolean(),
  )
  .map(
    ([tokens, joiner, head, tail, bom]) =>
      `${bom ? "\uFEFF" : ""}${head}${tokens.join(joiner)}${tail}`,
  );

const MALFORMED_RUNS = { numRuns: 2000 };

type DocNode = ReturnType<typeof parseHtml>["root"];

/**
 * The D60 oracle's `expected` side, rebuilt independently: the repo parse tree with the
 * element whose span is exactly `[start, end)` cut out of its parent, serialized. The
 * oracle accepts a splice only when re-parsing it produces this same tree.
 */
const cutBlock = (root: DocNode, start: number, end: number): DocNode => {
  if (root.kind !== "element" && root.kind !== "document") return root;
  return {
    ...root,
    children: root.children
      .filter(
        (child) =>
          !(child.kind === "element" && child.span?.start === start && child.span.end === end),
      )
      .map((child) => cutBlock(child, start, end)),
  };
};

const minusBlockSerialized = (html: string, start: number, end: number): string =>
  serializeHtml({
    root: cutBlock(parseHtml(html, { locations: true }).root, start, end),
    diagnostics: [],
  });

describe("property · malformed HTML (D58 ownership)", () => {
  it("should list only blocks whose slice carries no foreign tag tokens", () => {
    fc.assert(
      fc.property(badDocArb, (html) => {
        for (const block of listBlocks(html)) {
          const slice = html.slice(block.start, block.end);
          // The slice starts at the block's own start tag (tag names compare
          // lowercase: parse5 folds `<foreignObject>` to `foreignobject`).
          expect(slice.toLowerCase().startsWith(`<${block.tag.toLowerCase()}`)).toBe(true);
          expect(isTagBoundary(slice[block.tag.length + 1])).toBe(true);
          // The block's range must map onto a real element with a matching span.
          const owned = ownedIndexOf(html, block.start, block.end);
          expect(owned).toBeDefined();
          if (owned === undefined) return;
          // No start or end tag token inside the range belongs outside its subtree.
          expect(everyTagTokenOwned(html, owned, block.start, block.end)).toBe(true);
          // A listed block still resolves back to itself.
          expect(resolveAddress(html, block.address)).toEqual({ ok: true, block });
        }
      }),
      MALFORMED_RUNS,
    );
  });

  it("should refuse or exactly-own every listed block on delete (D60 oracle)", () => {
    fc.assert(
      fc.property(badDocArb, (html) => {
        const index = tagIndexOf(html);
        for (const block of listBlocks(html)) {
          const stripped = `${html.slice(0, block.start)}${html.slice(block.end)}`;
          const outcome = patchOrSkip(html, { address: block.address, action: "delete" });
          // The oracle refused: no write happened, which is always a legal outcome.
          if (outcome === undefined) continue;
          // Accepted: only the block's own bytes went, and the splice re-parses to
          // exactly the original tree minus the block's subtree.
          const removed = html.length - outcome.html.length;
          expect(outcome.html).toBe(stripped);
          expect(serializeHtml(parseHtml(outcome.html))).toBe(
            minusBlockSerialized(html, block.start, block.end),
          );
          // Every element start tag outside the deleted range keeps its bytes (shifted).
          for (const [tag, offset] of outsideTagBytes(index, block.start, block.end)) {
            const shifted = offset < block.start ? offset : offset - removed;
            // parse5 folds HTML tag names but keeps SVG camelCase — compare lowercase.
            const head = outcome.html.slice(shifted, shifted + tag.length + 1).toLowerCase();
            expect(head).toBe(`<${tag.toLowerCase()}`);
            expect(isTagBoundary(outcome.html[shifted + tag.length + 1])).toBe(true);
          }
        }
      }),
      MALFORMED_RUNS,
    );
  });

  it("should round-trip a replace back to the original bytes", () => {
    fc.assert(
      fc.property(badDocArb, (html) => {
        for (const block of listBlocks(html)) {
          const outcome = patchOrSkip(html, {
            address: block.address,
            action: "replace",
            html: `<${block.tag}>r</${block.tag}>`,
          });
          if (outcome?.address === undefined) continue;
          // Replace writes the fragment's serialized form, so undo is byte-exact only
          // for canonical slices — `<p>` serializes to `<p></p>`. Skip the rest.
          const slice = html.slice(block.start, block.end);
          const selfReplace = patchOrSkip(html, {
            address: block.address,
            action: "replace",
            html: slice,
          });
          if (selfReplace?.html !== html) continue;
          const back = patchOrSkip(outcome.html, {
            address: outcome.address,
            action: "replace",
            html: slice,
          });
          if (back === undefined) continue;
          expect(back.html).toBe(html);
        }
      }),
      MALFORMED_RUNS,
    );
  });
});
