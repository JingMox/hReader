// Renders the source document and outline into a single printable HTML file (cover / TOC / body); no disk, no process.

import {
  attributeOf,
  hasExternalResource,
  HrError,
  isCountedImage,
  isDroppedNode,
  KIND_ATTRIBUTE,
  parseHtml,
  sanitizedAttributesOf,
  serializeHtml,
} from "@hreader/core";
import type { HtmlElementNode, HtmlNode, OutlineNode } from "@hreader/core";

import { attributeStringOf, utf8LengthOf } from "./markup";
import { numberingOf } from "./numbering";
import type { Numbering } from "./numbering";
import type { PaperSize } from "./print-css";
import { printSheetOf, slidesSheetOf } from "./print-page";
import type { TocItem } from "./print-page";

type Attribute = HtmlElementNode["attrs"][number];

/** This package has exactly one use — print sheets; the preset parameter is a surface core reserves for `hr import`, so it is always `print` here. */
const SANITIZE_PRESET = "print" as const;

/**
 * What to print, which theme, and what body are all supplied by the caller: the package looks up no files and reads
 * no environment, so identical input always yields identical bytes.
 */
export interface PrintHtmlInput {
  /** Fallback chain when omitted: `<title>` → first `h1` → `docId`. */
  readonly title?: string;
  /** Stable document id (source basename minus extension): only lands in `<meta name="hr-doc-id">`, never in layout. */
  readonly docId: string;
  readonly visualId: string;
  /** Paper: required. It goes straight into `@page{size:…}`; the wrong paper means the type area gets cropped by the paper edge. */
  readonly paper: PaperSize;
  /** Emitted verbatim as the `<body>` class; omit or pass "" for no class. */
  readonly bodyClass?: string;
  /** Full HTML of the source document; this layer takes the outermost `<article>` and lays it out after trimming the UI. */
  readonly documentHtml: string;
  readonly outline: readonly OutlineNode[];
  /** Full theme CSS (`styles/<visual>/theme.css`); inlined into the product ahead of everything else. */
  readonly themeCss: string;
}

export interface PrintHtmlResult {
  readonly html: string;
  /**
   * Exact UTF-8 byte count of `html`: `productOf` computes this very number before assembly, letting callers check it
   * against 4 MiB and keep `--json.bytes` equal to `statSync(out).size`.
   */
  readonly bytes: number;
  /**
   * Counts images only: removed `<img>` and SVG `<image>`. `<video>`/`<audio>`/`<svg>`/`<iframe>` are dropped wholesale
   * but not counted — they are not "images", and counting them would make the "N external images removed" line a lie.
   */
  readonly droppedImages: number;
  /**
   * `true` = the product is a slides print sheet (no cover/TOC; page geometry declared by CSS `@page`).
   * The renderer uses it to decide whether to obey CSS or the CLI paper argument (`hr pdf`'s `preferCSSPageSize`).
   */
  readonly slides: boolean;
}

const DOC_ID_ATTRIBUTE = "data-hr-id";

/** Class name of the number span; `print-css.ts` styles the same class, so both places must agree on the spelling. */
const SECNUM_CLASS = "secnum";

/**
 * Every walker in this file (`findElement`/`textOf`/`rewrittenChildrenOf`/`reservedIdsOf`,
 * plus `visit` in `numbering.ts`) is recursive — the input is user HTML with no natural
 * depth bound, and ~90k nesting levels used to unwind it with a bare `RangeError`. Measure
 * the depth once at the entry: the explicit-stack DFS cannot blow the stack itself, and
 * over-limit input throws the structured `invalid_document` which feeds run.ts's code map.
 * Outline depth is a subset of document depth (every outline node maps to a document
 * element), so the same gate covers it.
 */
const DEPTH_LIMIT = 2048;

/** Explicit-stack depth measurement: only element/document children count; text and comment nodes add no level. */
const depthOf = (root: HtmlNode): number => {
  let max = 0;
  const stack: { readonly node: HtmlNode; readonly depth: number }[] = [{ node: root, depth: 1 }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (frame.depth > max) max = frame.depth;
    const node = frame.node;
    if (node.kind !== "element" && node.kind !== "document") continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push({ node: child, depth: frame.depth + 1 });
    }
  }
  return max;
};

const textOf = (node: HtmlNode): string => {
  if (node.kind === "text") {
    return node.value;
  }
  if (node.kind === "element" || node.kind === "document") {
    return node.children.map((child) => textOf(child)).join("");
  }
  return "";
};

const findElement = (node: HtmlNode, tag: string): HtmlElementNode | undefined => {
  if (node.kind === "element" && node.tag === tag) {
    return node;
  }
  if (node.kind !== "element" && node.kind !== "document") {
    return undefined;
  }
  for (const child of node.children) {
    const found = findElement(child, tag);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

const textOfTag = (node: HtmlNode, tag: string): string => {
  const element = findElement(node, tag);
  return element === undefined ? "" : textOf(element).trim();
};

const coverTitleOf = (input: PrintHtmlInput, root: HtmlNode, article: HtmlElementNode): string => {
  const candidates = [
    input.title?.trim() ?? "",
    textOfTag(root, "title"),
    textOfTag(article, "h1"),
    input.docId,
  ];
  return candidates.find((text) => text !== "") ?? input.docId;
};

interface RewriteState {
  readonly numbering: Numbering;
  /** `data-hr-id` → anchor name unique within the document; allocated once after reserving ids across the whole tree, then only looked up while writing. */
  readonly anchorById: ReadonlyMap<string, string>;
  droppedImages: number;
}

/**
 * Anchor allocation: guaranteed only to "not collide with any existing `id`", **not** to be unique tree-wide. Duplicate
 * `id`s shipped in the source document are kept as-is (rewriting them would break `<a href="#x">` internal links, and a
 * duplicate `id` is already invalid HTML — the source document is what needs fixing).
 * Latecomers yield: if `sec-1` is taken, `sec-1-2`, `sec-1-3`, … — the first free slot in allocation order wins.
 */
const anchorOf = (base: string, used: Set<string>): string => {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${String(suffix)}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

/** `id`s that will be kept verbatim (non-heading, non-container) reserve their slots first, so generated `sec-…` anchors steer around them. */
const reservedIdsOf = (node: HtmlElementNode, numbering: Numbering, used: Set<string>): void => {
  if (isDroppedNode(node, SANITIZE_PRESET) || hasExternalResource(node, SANITIZE_PRESET)) {
    return;
  }
  const sectionId = attributeOf(node, DOC_ID_ATTRIBUTE);
  const id = attributeOf(node, "id");
  if (id !== undefined && !numbering.numberById.has(sectionId ?? "")) {
    used.add(id);
  }
  for (const child of node.children) {
    if (child.kind === "element") {
      reservedIdsOf(child, numbering, used);
    }
  }
};

const chapterClassOf = (node: HtmlElementNode): Attribute => {
  const existing = attributeOf(node, "class") ?? "";
  return ["class", existing === "" ? "chapter" : `${existing} chapter`];
};

/** No duplicate attributes: emitting `id="sec-…"` drops the source `id`; emitting `chapter` drops the source `class`. */
const attributesOf = (
  node: HtmlElementNode,
  chapter: boolean,
  anchor: string | undefined,
): readonly Attribute[] => {
  const kept = sanitizedAttributesOf(node, SANITIZE_PRESET).filter(
    ([name]) => !(anchor !== undefined && name === "id") && !(chapter && name === "class"),
  );
  const idAttribute: readonly Attribute[] = anchor === undefined ? [] : [["id", anchor]];
  return chapter ? [...kept, chapterClassOf(node), ...idAttribute] : [...kept, ...idAttribute];
};

const numberSpanOf = (number: string): HtmlElementNode => ({
  kind: "element",
  tag: "span",
  attrs: [["class", SECNUM_CLASS]],
  children: [{ kind: "text", value: `${number} ` }],
});

/**
 * A heading starting with `<span class="secnum">` = this subtree was exported before.
 * Only the first child counts: the number is always frontmost, and a secnum the author wrote into body text must not be touched.
 */
const isSecnumSpan = (node: HtmlNode | undefined): boolean =>
  node?.kind === "element" && node.tag === "span" && attributeOf(node, "class") === SECNUM_CLASS;

/** An existing number gets replaced, not wrapped: re-exporting a print sheet must not produce "1 1 <title>". */
const withoutLeadingSecnum = (children: readonly HtmlNode[]): readonly HtmlNode[] =>
  isSecnumSpan(children[0]) ? children.slice(1) : children;

const rewrittenElementOf = (
  node: HtmlElementNode,
  state: RewriteState,
): HtmlElementNode | undefined => {
  if (isDroppedNode(node, SANITIZE_PRESET)) {
    if (isCountedImage(node)) {
      state.droppedImages += 1;
    }
    return undefined;
  }
  if (hasExternalResource(node, SANITIZE_PRESET)) {
    if (isCountedImage(node)) {
      state.droppedImages += 1;
    }
    return undefined;
  }
  const sectionId = attributeOf(node, DOC_ID_ATTRIBUTE);
  const number = sectionId === undefined ? undefined : state.numbering.numberById.get(sectionId);
  const chapter = sectionId !== undefined && state.numbering.chapterIds.has(sectionId);
  const anchor = sectionId === undefined ? undefined : state.anchorById.get(sectionId);
  const children = rewrittenChildrenOf(node.children, state);
  return {
    kind: "element",
    // A nested `<article>` is demoted to `div` (attributes kept): the product may contain exactly one `<article>`.
    tag: node.tag === "article" ? "div" : node.tag,
    attrs: attributesOf(node, chapter, anchor),
    children:
      number === undefined ? children : [numberSpanOf(number), ...withoutLeadingSecnum(children)],
  };
};

const rewrittenChildrenOf = (
  children: readonly HtmlNode[],
  state: RewriteState,
): readonly HtmlNode[] => {
  const rewritten: HtmlNode[] = [];
  for (const child of children) {
    const kept = child.kind === "element" ? rewrittenElementOf(child, state) : child;
    if (kept !== undefined) {
      rewritten.push(kept);
    }
  }
  return rewritten;
};

/**
 * The empty-sheet check is **text-level**, not markup-level: `<section></section>` serializes to something non-empty yet
 * prints nothing, and letting it pass would smuggle an empty chapter past validation. Walk the text nodes via parseHtml
 * instead of stripping tags by regex.
 * Zero-width characters (`U+200B`/`U+FEFF`/`U+180E`) take no room on paper and `trim()` does not see them, so strip them first.
 */
const ZERO_WIDTH = /[\u200B\uFEFF\u180E]/gu;
const hasText = (html: string): boolean =>
  textOf(parseHtml(html).root).replaceAll(ZERO_WIDTH, "").trim() !== "";

const articleBodyOf = (article: HtmlElementNode, state: RewriteState): string => {
  const body = serializeHtml({
    root: { kind: "document", children: rewrittenChildrenOf(article.children, state) },
    diagnostics: [],
  });
  if (!hasText(body)) {
    throw new HrError(
      "empty_document",
      "裁掉交互 UI 与外部资源后正文没有任何文字，拒绝产出空白打印稿",
    );
  }
  return body;
};

export const printHtmlReportOf = (input: PrintHtmlInput): PrintHtmlResult => {
  // No id injection: the export keeps only the `data-hr-id`s the source document already had —
  // an id scraped off the print sheet would just earn `node_not_found` when fed to `patch`.
  const parsed = parseHtml(input.documentHtml);
  const depth = depthOf(parsed.root);
  if (depth > DEPTH_LIMIT) {
    throw new HrError(
      "invalid_document",
      `文档嵌套 ${String(depth)} 层，超过打印稿的深度上限 ${String(DEPTH_LIMIT)}`,
    );
  }
  const article = findElement(parsed.root, "article");
  if (article === undefined) {
    throw new HrError("no_article", "源文档里没有 <article>，无法导出打印稿");
  }
  const slides = attributeOf(article, KIND_ATTRIBUTE) === "slides";
  // Slides get no numbers and no chapter class: page titles should not carry a "1.2" prefix, and there is no TOC page anyway.
  const numbering = slides ? numberingOf([]) : numberingOf(input.outline);
  const usedIds = new Set<string>();
  reservedIdsOf(article, numbering, usedIds);
  // Entries and numbers share one source (outline order), so anchors are likewise allocated once per entry.
  const tocItems: readonly TocItem[] = numbering.entries.map((entry) => ({
    entry,
    anchor: anchorOf(`sec-${entry.number}`, usedIds),
  }));
  const anchorById = new Map(tocItems.map((item) => [item.entry.id, item.anchor]));
  const state: RewriteState = { numbering, anchorById, droppedImages: 0 };
  const body = articleBodyOf(article, state);
  const title = coverTitleOf(input, parsed.root, article);
  const tocIds = {
    nav: anchorOf("hr-toc", usedIds),
    title: anchorOf("hr-toc-title", usedIds),
  };
  const sheet = {
    paper: input.paper,
    title,
    docId: input.docId,
    visualId: input.visualId,
    themeCss: input.themeCss,
    bodyClass: input.bodyClass,
    tocItems,
    tocIds,
    articleOpen: `<article${attributeStringOf(sanitizedAttributesOf(article, SANITIZE_PRESET))}>`,
    body,
  };
  const html = slides ? slidesSheetOf(sheet) : printSheetOf(sheet);
  return { html, bytes: utf8LengthOf(html), droppedImages: state.droppedImages, slides };
};

export const printHtmlOf = (input: PrintHtmlInput): string => printHtmlReportOf(input).html;
