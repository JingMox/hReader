// The D58 source-ownership property: over ≥2000 malformed-HTML documents (ignored end
// tags, fostered content, AAA misnesting, foreign subtrees, quirks, BOM/CRLF), every
// listed block's slice must be provably its own bytes — tag tokens owned by the
// subtree, deletes preserving outside bytes and outside source tags, replace+undo
// byte-identical. Each run patches every listed block, so one pass costs ~10⁴ whole-
// document parse+serialize cycles: far past the unit suite's 30s budget under v8
// coverage instrumentation, with no way to time it reliably (same reason the 10 MB
// checks live here — vitest.perf.config.ts gives the real wall-clock budget).

import {
  parse as parse5,
  parseFragment as parse5Fragment,
  type DefaultTreeAdapterTypes,
} from "parse5";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { malformedHtmlArb } from "../adversarial/html-generator";
import { MALFORMED_HTML } from "../adversarial/html-malformed";

import {
  applyBlockPatch,
  listBlocks,
  parseFragment,
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
      // The fragment gates refuse executable/external containers (`<style>` inside a
      // block's own slice, `<noscript>` markup, …) — a legal outcome, not a defect.
      code === "forbidden_content" ||
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
type P5Document = DefaultTreeAdapterTypes.Document;

const isP5Element = (node: P5Node): node is P5Element => "tagName" in node;

const nameOf = (node: P5Node): string => (node as { nodeName: string }).nodeName;

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
  // Iterative: the corpus's depth-stress documents overflow a recursive walk.
  const pending: [P5Node, string | undefined][] = [[document, undefined]];
  for (;;) {
    const frame = pending.pop();
    if (frame === undefined) break;
    const [node, parentTag] = frame;
    if (isP5Element(node)) {
      const location = node.sourceCodeLocation;
      if (location?.startTag !== undefined) {
        starts.add(location.startTag.startOffset);
        elements.push([node.tagName, location.startTag.startOffset]);
      }
      if (location?.endTag !== undefined) ends.add(location.endTag.startOffset);
      const children = "content" in node ? node.content.childNodes : p5ChildrenOf(node);
      for (const child of [...children].reverse()) pending.push([child, node.tagName]);
      continue;
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
    for (const child of [...p5ChildrenOf(node)].reverse()) pending.push([child, undefined]);
  }
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
  // Iterative, like `tagIndexOf` — corpus depth stress overflows recursion.
  const toFind: P5Node[] = [document];
  for (;;) {
    const node = toFind.pop();
    if (node === undefined) break;
    if (isP5Element(node)) {
      const location = node.sourceCodeLocation;
      if (location?.startTag?.startOffset === start && location.endOffset === end) {
        matches.push(node);
      }
      const children = "content" in node ? node.content.childNodes : p5ChildrenOf(node);
      toFind.push(...children);
      continue;
    }
    toFind.push(...p5ChildrenOf(node));
  }
  if (matches.length === 0) return undefined;
  const starts = new Set<number>();
  const ends = new Set<number>();
  const skips: [number, number][] = [];
  const pending: [P5Node, string | undefined][] = matches.map((match) => [match, undefined]);
  for (;;) {
    const frame = pending.pop();
    if (frame === undefined) break;
    const [node, parentTag] = frame;
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
      for (const child of children) pending.push([child, node.tagName]);
      continue;
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
    for (const child of p5ChildrenOf(node)) pending.push([child, undefined]);
  }
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

/** The string-carrying entries of the shared adversarial corpus (`bytes` entries are encodings a JS string cannot hold). */
const corpusDocs: readonly string[] = MALFORMED_HTML.flatMap((entry) =>
  "html" in entry ? [entry.html] : [],
);

/**
 * Documents under test: the generator plus every shared-corpus document and the
 * corpus's own seeded generator — one arbitrary, all three sources.
 */
const docArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: badDocArb },
  { weight: 2, arbitrary: malformedHtmlArb },
  { weight: 1, arbitrary: fc.constantFrom(...corpusDocs) },
);

const MALFORMED_RUNS = { numRuns: 2000, seed: 0xd58 };

/**
 * The independent raw-parse5 checkers below judge what the D68 oracles must
 * guarantee, on the DOM the bytes actually build: `parse5.parse` /
 * `parse5.parseFragment` output — no hReader normalization — in BOTH scripting
 * modes. `p5Children` treats `<template>` content as the element's children.
 */
const p5Children = (node: P5Node): readonly P5Node[] =>
  isP5Element(node) && "content" in node
    ? (node as unknown as { content: { childNodes: P5Node[] } }).content.childNodes
    : "childNodes" in node
      ? (node as unknown as { childNodes: P5Node[] }).childNodes
      : [];

/** Slot on raw parse5 output — the node whose source extent is exactly `[start, end)`. */
interface P5Slot {
  readonly node: P5Node;
  readonly parent: P5Node;
  readonly index: number;
}

const rawLocationOf = (node: P5Node): { startOffset: number; endOffset: number } | undefined => {
  const location = (
    node as unknown as { sourceCodeLocation?: { startOffset: number; endOffset: number } | null }
  ).sourceCodeLocation;
  return location == null
    ? undefined
    : { startOffset: location.startOffset, endOffset: location.endOffset };
};

const findP5Slot = (root: P5Node, start: number, end: number): P5Slot | undefined => {
  const queue: [P5Node, P5Node][] = [[root, root]];
  for (;;) {
    const pair = queue.shift();
    if (pair === undefined) break;
    const [node, parent] = pair;
    const location = rawLocationOf(node);
    if (
      isP5Element(node) &&
      location !== undefined &&
      (node as unknown as { sourceCodeLocation?: { startTag?: unknown } }).sourceCodeLocation
        ?.startTag !== undefined &&
      location.startOffset === start &&
      location.endOffset === end &&
      p5Children(parent).includes(node)
    ) {
      return { node, parent, index: p5Children(parent).indexOf(node) };
    }
    for (const child of p5Children(node)) queue.push([child, node]);
  }
  return undefined;
};

const p5AttrsEq = (left: P5Element, right: P5Element): boolean =>
  left.attrs.map((attr) => `${attr.name}\0${attr.value}\0${attr.namespace ?? ""}`).join("\0") ===
  right.attrs.map((attr) => `${attr.name}\0${attr.value}\0${attr.namespace ?? ""}`).join("\0");

const p5Merged = (children: readonly P5Node[]): readonly P5Node[] => {
  const merged: P5Node[] = [];
  for (const child of children) {
    const last = merged[merged.length - 1];
    if (
      (child as { nodeName: string }).nodeName === "#text" &&
      (last as { nodeName?: string } | undefined)?.nodeName === "#text"
    ) {
      const mergedText = {
        ...(last as object),
        value: (last as { value: string }).value + (child as { value: string }).value,
      };
      merged[merged.length - 1] = mergedText as unknown as P5Node;
    } else {
      merged.push(child);
    }
  }
  return merged;
};

/** One node's own payload — kind, tag, namespace, attrs, leaf data. Children pair up in the walk below. */
const p5PayloadEq = (left: P5Node, right: P5Node): boolean => {
  if (nameOf(left) !== nameOf(right)) return false;
  if (isP5Element(left) && isP5Element(right)) {
    return (
      left.tagName === right.tagName &&
      left.namespaceURI === right.namespaceURI &&
      p5AttrsEq(left, right)
    );
  }
  if (nameOf(left) === "#text")
    return (left as { value: string }).value === (right as { value: string }).value;
  if (nameOf(left) === "#comment")
    return (left as { data: string }).data === (right as { data: string }).data;
  if (nameOf(left) === "#documentType")
    return (
      (left as { name: string }).name === (right as { name: string }).name &&
      (left as { publicId: string }).publicId === (right as { publicId: string }).publicId &&
      (left as { systemId: string }).systemId === (right as { systemId: string }).systemId
    );
  return nameOf(left) === "#document";
};

const rawParse = (html: string, scripting: boolean): P5Document =>
  parse5(html, { sourceCodeLocationInfo: true, scriptingEnabled: scripting });

const rawFragmentNodes = (text: string, scripting: boolean): readonly P5Node[] =>
  p5Children(
    parse5Fragment(text, {
      sourceCodeLocationInfo: true,
      scriptingEnabled: scripting,
    }),
  );

/**
 * Whole-tree equality between the expected tree (`left`, built from the original
 * raw nodes) and the parsed result (`right`) — except at `woundParent`, where
 * `right`'s child list must equal `expectedAtWound`, with text-run merging
 * applied at that level only (the splice can leave adjacent text siblings a
 * re-parse folds together).
 */
const p5SameExceptWound = (
  left: P5Node,
  right: P5Node,
  woundParent: P5Node,
  expectedAtWound: readonly P5Node[],
): boolean => {
  // Iterative pairwise walk — the corpus's depth-stress documents overflow recursion.
  const pending: [P5Node, P5Node][] = [[left, right]];
  for (;;) {
    const pair = pending.pop();
    if (pair === undefined) break;
    const [a, b] = pair;
    if (!p5PayloadEq(a, b)) return false;
    const atWound = a === woundParent;
    const aKids = atWound ? p5Merged(expectedAtWound) : p5Children(a);
    const bKids = atWound ? p5Merged(p5Children(b)) : p5Children(b);
    if (aKids.length !== bKids.length) return false;
    for (let index = 0; index < aKids.length; index += 1) {
      const childA = aKids[index];
      const childB = bKids[index];
      if (childA === undefined || childB === undefined) return false;
      pending.push([childA, childB]);
    }
  }
  return true;
};

/**
 * Independent write-oracle check, both scripting modes: bytes outside the splice
 * stay verbatim, and the result's raw tree equals the original's except at the
 * wound — where the child list must be exactly what the action dictates.
 */
const rawWriteJudged = (
  html: string,
  result: string,
  start: number,
  end: number,
  action: "replace" | "insertBefore" | "insertAfter",
  text: string,
): boolean => {
  const from = action === "insertAfter" ? end : start;
  const to = action === "insertBefore" ? start : end;
  const tail = result.slice(result.length - (html.length - to));
  if (result.slice(0, from) !== html.slice(0, from) || tail !== html.slice(to)) return false;
  return [false, true].every((scripting) => {
    const original = rawParse(html, scripting);
    const slot = findP5Slot(original, start, end);
    if (slot === undefined || !isP5Element(slot.node)) return false;
    const children = p5Children(slot.parent);
    const fragment = rawFragmentNodes(text, scripting);
    let expected: readonly P5Node[];
    if (action === "replace") {
      expected = children.flatMap((child) => (child === slot.node ? fragment : [child]));
    } else if (action === "insertBefore") {
      expected = children.flatMap((child) =>
        child === slot.node ? [...fragment, child] : [child],
      );
    } else {
      expected = children.flatMap((child) =>
        child === slot.node ? [child, ...fragment] : [child],
      );
    }
    return p5SameExceptWound(original, rawParse(result, scripting), slot.parent, expected);
  });
};

/** Independent delete-oracle check: the result is the original raw tree minus the block's subtree, both modes. */
const rawDeleteJudged = (html: string, result: string, start: number, end: number): boolean => {
  if (result !== `${html.slice(0, start)}${html.slice(end)}`) return false;
  return [false, true].every((scripting) => {
    const original = rawParse(html, scripting);
    const slot = findP5Slot(original, start, end);
    if (slot === undefined || !isP5Element(slot.node)) return false;
    const expected = p5Children(slot.parent).filter((child) => child !== slot.node);
    return p5SameExceptWound(original, rawParse(result, scripting), slot.parent, expected);
  });
};

/** Fragments that exercise scope-close, AAA, nested-form, raw-text and foreign-content breakouts. */
const FRAGMENTS = [
  "<p>f</p>",
  "<li>f</li>",
  "<dd>f</dd>",
  "<dt>f</dt>",
  "<a>f</a>",
  "<nobr>f</nobr>",
  "<form><p>f</p></form>",
  "<table><tr><td>f</td></tr></table>",
  "<td>f</td>",
  "<tr><td>f</td></tr>",
  "<tbody><tr><td>f</td></tr></tbody>",
  "<caption>f</caption>",
  "<option>f</option>",
  "<select><option>f</option></select>",
  "<button><div>f</div></button>",
  "<object><p>f</p></object>",
  "<marquee>f</marquee>",
  "<template><p>f</p></template>",
  "<noscript><p>f</p></noscript>",
  "<blockquote><p>f</p></blockquote>",
  "<div>f</div>",
  "<span>f</span>",
  "<svg><p>f</p></svg>",
  "<math><p>f</p></math>",
  "<button>f</button>",
] as const;

const fragArb = fc.constantFrom(...FRAGMENTS);

describe("property · malformed HTML (D58 ownership)", () => {
  it("should list only blocks whose slice carries no foreign tag tokens", () => {
    fc.assert(
      fc.property(docArb, (html) => {
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
      fc.property(docArb, (html) => {
        const index = tagIndexOf(html);
        for (const block of listBlocks(html)) {
          const stripped = `${html.slice(0, block.start)}${html.slice(block.end)}`;
          const outcome = patchOrSkip(html, { address: block.address, action: "delete" });
          // The oracle refused: no write happened, which is always a legal outcome.
          if (outcome === undefined) continue;
          // Accepted: only the block's own bytes went, and the splice's RAW parse5
          // tree — the DOM the bytes actually build — is exactly the original minus
          // the block's subtree, in both scripting modes (independent check).
          const removed = html.length - outcome.html.length;
          expect(outcome.html).toBe(stripped);
          expect(
            rawDeleteJudged(html, outcome.html, block.start, block.end),
            `delete at ${block.address} in ${html}`,
          ).toBe(true);
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

  it("should refuse or land in-context every listed block on write (D64 oracle)", () => {
    fc.assert(
      fc.property(docArb, fragArb, (html, fragmentSource) => {
        let text: string;
        try {
          // The bytes the impl splices in: the parsed fragment, serialized.
          text = serializeHtml({
            root: { kind: "document", children: [parseFragment(fragmentSource)] },
            diagnostics: [],
          });
        } catch {
          return;
        }
        for (const block of listBlocks(html)) {
          for (const action of ["replace", "insertBefore", "insertAfter"] as const) {
            const outcome = patchOrSkip(html, {
              address: block.address,
              action,
              html: fragmentSource,
            });
            // Refused (oracle, content model, fragment gates): nothing was written.
            if (outcome === undefined) continue;
            // Accepted, verified on the raw parse5 trees in both scripting modes:
            // (a) bytes outside the splice stay verbatim; (b) every element outside
            // the block's wound keeps tag/attrs/children; (c) the fragment's
            // top-level raw nodes sit exactly where the action puts them among the
            // wound parent's children — nowhere else.
            expect(
              rawWriteJudged(html, outcome.html, block.start, block.end, action, text),
              `${action} ${fragmentSource} at ${block.address} in ${html}`,
            ).toBe(true);
          }
        }
      }),
      MALFORMED_RUNS,
    );
  });

  it("should round-trip a replace back to the original bytes", () => {
    fc.assert(
      fc.property(docArb, (html) => {
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
