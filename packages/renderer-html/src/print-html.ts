// 这层管：把源文档与 outline 渲染成单文件可打印 HTML（封面 / 目录 / 正文三段）；不读盘、不碰进程。

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

/** 本包只有打印稿一个用途；preset 参数化是 core 给 `hr import` 预留的面，这里恒为 print。 */
const SANITIZE_PRESET = "print" as const;

/**
 * 印什么、用哪个主题、正文是什么，全部由调用方给出：包内不找文件、不读环境，同输入必然同字节。
 */
export interface PrintHtmlInput {
  /** 不传则回落：`<title>` → 首个 `h1` → `docId`。 */
  readonly title?: string;
  /** 稳定文档标识（源文件 basename 去扩展名）：只进 `<meta name="hr-doc-id">`，不参与排版。 */
  readonly docId: string;
  readonly visualId: string;
  /** 纸张：必填。它直接进 `@page{size:…}`，选错纸就是版心被纸边切掉。 */
  readonly paper: PaperSize;
  /** `<body>` 的类名原样输出；不传或空串表示不加类。 */
  readonly bodyClass?: string;
  /** 源文档全文 HTML；本层取最外层 `<article>`，裁掉 UI 后再排。 */
  readonly documentHtml: string;
  readonly outline: readonly OutlineNode[];
  /** 主题 CSS 全文（`styles/<visual>/theme.css`），内联进产物且排在最前。 */
  readonly themeCss: string;
}

export interface PrintHtmlResult {
  readonly html: string;
  /**
   * `html` 的 UTF-8 字节数，精确值：`productOf` 在拼接前算的就是它（同一个数），调用方拿它与
   * 4 MiB 对表，并保证 `--json.bytes` 与 `statSync(out).size` 相等。
   */
  readonly bytes: number;
  /**
   * 口径只算图片：被删的 `<img>` 与 SVG `<image>`。`<video>`/`<audio>`/`<svg>`/`<iframe>` 是整删，
   * 不计数——它们不是"图片"，算进来会让那句"已移除 N 个外部图片"说谎。
   */
  readonly droppedImages: number;
  /**
   * `true` = 产物是 slides 打印稿（无封面/目录、页框由 CSS `@page` 声明）。
   * 渲染方据此决定听 CSS 的还是听命令行纸张参数的（`hr pdf` 的 `preferCSSPageSize`）。
   */
  readonly slides: boolean;
}

const DOC_ID_ATTRIBUTE = "data-hr-id";

/** 序号 span 的类名；`print-css.ts` 用同名类排版，两处必须同一个拼写。 */
const SECNUM_CLASS = "secnum";

/**
 * 本文件的 walker（`findElement`/`textOf`/`rewrittenChildrenOf`/`reservedIdsOf`，
 * 还有 `numbering.ts` 的 `visit`）全是递归——输入是用户 HTML，没有天然深度上限，
 * ~9 万层嵌套就让递归以裸 `RangeError` 退栈（L-40）。在入口量一次深度：
 * 显式栈 DFS 自己不烧栈；超限抛结构化的 `invalid_document`，进 run.ts 的错误码映射。
 * outline 的深度是文档深度的子集（每个 outline 节点都对应一个文档元素），同一道闸兜底。
 */
const DEPTH_LIMIT = 2048;

/** 显式栈深度测量：只走 element/document 的孩子，文本/注释节点不产生层级。 */
const depthOf = (root: HtmlNode): number => {
  let max = 0;
  const stack: { readonly node: HtmlNode; readonly depth: number }[] = [
    { node: root, depth: 1 },
  ];
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
  /** `data-hr-id` → 文档内唯一的锚名；在全树占位后一次性分配，写树时只查表。 */
  readonly anchorById: ReadonlyMap<string, string>;
  droppedImages: number;
}

/**
 * 生成锚：只保证"不与任何既有 `id` 冲突"，**不**保证全树唯一。源文档自带的重复 `id` 原样保留
 * （改写它会打断 `<a href="#x">` 的内部链接语义，而重复 `id` 本身就是非法 HTML——该修的是源文档）。
 * 后到者让位：`sec-1` 被占了就 `sec-1-2`、`sec-1-3`…按分配顺序取第一个空位。
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

/** 会被原样保留的 `id`（非标题/非容器的）先占位；等会儿生成的 `sec-…` 绕开它们走。 */
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

/** 同名属性不重复：加了 `id="sec-…"` 就摘掉源 `id`，加了 `chapter` 就摘掉源 `class`。 */
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
 * 带 `<span class="secnum">` 开头的标题 = 这棵子树曾被导出过。
 * 只认第一个子节点：序号永远在最前，作者自己写在正文里的 secnum 不该被动。
 */
const isSecnumSpan = (node: HtmlNode | undefined): boolean =>
  node?.kind === "element" && node.tag === "span" && attributeOf(node, "class") === SECNUM_CLASS;

/** 已有序号就换掉它而不是再套一层：对打印稿再 `export` 一次不该变成「1 1 季度复盘」。 */
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
    // 嵌套 `<article>` 降级为 `div`（属性原样留），产物里只许有一个 `<article>`。
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
 * 空稿判据是**文本级**而非标记级：`<section></section>` 序列化后非空，但纸面上什么都没有，
 * 放了它就等于用一个空 chapter 蒙过校验。用 parseHtml 走一遍文本节点，不用正则剥标签。
 * 零宽字符（`U+200B`/`U+FEFF`/`U+180E`）在纸面上不占位，`trim()` 又不认它们，故先剥再判。
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
  // 不注入 id：导出产物里只有源文档本来就有的 `data-hr-id`，
  // 否则用户从打印稿拄下来的 id 拿去 `patch` 只会得到 `node_not_found`。
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
  // slides 不编号也不加 chapter 类：页标题不该带"1.2"前缀，目录页本来就没有。
  const numbering = slides ? numberingOf([]) : numberingOf(input.outline);
  const usedIds = new Set<string>();
  reservedIdsOf(article, numbering, usedIds);
  // 条目与编号同源（都来自 outline 的顺序），故锚也只按条目分配一次。
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
