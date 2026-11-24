// R2-06a（docs/05:60 末句）：`<p>甲<table>…</table>乙</p>` 拆成两段时，**"原来那个元素"是首段**——
// 首段留原 `data-hr-id`，后续段不带 id、由注入阶段分配。这层管 `parseHtml` 的产树结果；
// 落盘之后"删首段只删首段"还在 `packages/cli/tests/implicit-end-tags.test.ts` 里钉一遍。
//
// 为什么要单独钉 `data-hr-id` 的归属：注入阶段会把重复 id 改名，所以"照抄原 id"在**最终字节**上
// 可能看不出差别（第二个分段照样拿到一个合法新 id）——只有直接看解析产树才能证明第二个分段
// 本来**不带** id（`implicitClose.ts` 的 `withoutHrId`）。否则这段判据会被注入的去重逻辑吞掉。

import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml, serializeHtml } from "../src/index";
import { closeImplicitParagraphs } from "../src/html/implicitClose";
import type { HtmlElementNode, HtmlNode, ParsedHtml } from "../src/index";
import { attributeValue, childrenOf, requireElement } from "./html-support.test";

const HR_ID = "data-hr-id";
const HR_ID_SHAPE = /^hr-[0-9a-f]{8}$/u;

/** quirks 文档（**没有** doctype）：`<p>` 里的 `<table>` 只有我们自己的 `implicitClose` 会挪出去。 */
const QUIRKS_DOC = [
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="hr-p1">甲',
  '<table data-hr-id="hr-t"><tr><td data-hr-id="hr-c">1</td></tr></table>',
  "乙</p></article>",
  "</body></html>",
].join("");

/** 同上，但表格隔着一层 `<span>`：parse5 在 quirks 下也不会关 `p`，得靠 `hasBlockInside` 往里看。 */
const QUIRKS_NESTED_DOC = [
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="hr-p1">甲<span data-hr-id="hr-s">',
  '<table data-hr-id="hr-t"><tr><td data-hr-id="hr-c">1</td></tr></table>',
  "</span>乙</p></article>",
  "</body></html>",
].join("");

const bodyOf = (parsed: ParsedHtml): HtmlElementNode => {
  const html = requireElement(parsed.root, "html");
  return requireElement(html, "body");
};

const articleChildrenOf = (parsed: ParsedHtml): readonly HtmlNode[] =>
  childrenOf(requireElement(bodyOf(parsed), "article"));

const paragraphsOf = (parsed: ParsedHtml): readonly HtmlElementNode[] =>
  articleChildrenOf(parsed).filter(
    (node): node is HtmlElementNode => node.kind === "element" && node.tag === "p",
  );

const idOf = (element: HtmlElementNode): string | undefined => attributeValue(element, HR_ID);

const twoPiecesOf = (parsed: ParsedHtml): readonly [HtmlElementNode, HtmlElementNode] => {
  const [first, second] = paragraphsOf(parsed);
  if (first === undefined || second === undefined) throw new Error("没有拆成两段 <p>");
  return [first, second];
};

describe("parseHtml · 分裂出来的段落 id 归属（R2-06a）", () => {
  it("should keep the original id on the first piece and leave the later piece id-less", () => {
    const parsed = parseHtml(QUIRKS_DOC);

    // 表格是两段 `<p>` 之间的**兄弟**，不在任何 `<p>` 里。
    expect(articleChildrenOf(parsed).map((node) => node.kind === "element" && node.tag)).toEqual([
      "p",
      "table",
      "p",
    ]);
    const [first, second] = twoPiecesOf(parsed);

    // 首段 = 原来那个元素：id 原样留在它身上。
    expect(idOf(first)).toBe("hr-p1");
    // 后续段在源码里没有自己的标签，也就没有"自己"的 id：注入阶段才算得出来。
    expect(idOf(second)).toBeUndefined();
  });

  it("should hand the id-less piece a fresh id at injection time, not the original one", () => {
    const injected = injectNodeIds(parseHtml(QUIRKS_DOC));
    const [first, second] = twoPiecesOf(injected.parsed);

    expect(idOf(first)).toBe("hr-p1");
    const secondId = idOf(second);
    expect(secondId).toMatch(HR_ID_SHAPE);
    expect(secondId).not.toBe("hr-p1");
    // 注入清单里出现的就是这一段的新 id（不是重命名，是全新分配）。
    expect(injected.injected).toContain(secondId);
  });

  it("should be idempotent: re-parsing the serialized result splits nothing new", () => {
    const injected = injectNodeIds(parseHtml(QUIRKS_DOC));
    const [, second] = twoPiecesOf(injected.parsed);
    const again = injectNodeIds(parseHtml(serializeHtml(injected.parsed)));

    expect(again.injected).toEqual([]);
    expect(paragraphsOf(again.parsed).map(idOf)).toEqual(["hr-p1", idOf(second)]);
  });
});

describe("parseHtml · 分裂出来的段落区间与嵌套块（R2-06a）", () => {
  it("should give each piece its own source range when locations are on", () => {
    const parsed = parseHtml(QUIRKS_DOC, { locations: true });
    const [first, second] = twoPiecesOf(parsed);

    // 首段止于表格开始处（`start` 是它自己那段内容的起点，`<p …>` 开始标签归它）；第二段只有“乙”，
    // 不把挪出去的表格包进去——两段的区间不重叠，各自删得掉。
    expect(first.span?.end).toBe(QUIRKS_DOC.indexOf("<table"));
    expect(second.span?.start).toBe(QUIRKS_DOC.indexOf("乙"));
    // 第二段的 `end` 取到 `<p>` 的结束处（`</p>` 跟着它），至少非空且不回头盖住首段。
    expect(Number(second.span?.end)).toBeGreaterThan(QUIRKS_DOC.indexOf("乙"));
    expect(Number(first.span?.start)).toBeLessThan(QUIRKS_DOC.indexOf("<table"));
    expect(Number(first.span?.end)).toBeLessThanOrEqual(Number(second.span?.start));
  });
  it("should hoist a block that sits inside inline markup, not only a direct child", () => {
    // 文件头那条规则的另一半：`<p>a<span><table>` 里块隔着一层行内元素，parse5 同样不关 `p`。
    const parsed = parseHtml(QUIRKS_NESTED_DOC);

    expect(articleChildrenOf(parsed).map((node) => node.kind === "element" && node.tag)).toEqual([
      "p",
      "span",
      "p",
    ]);
    // 被挪出去的是整个 `<span>`（表格还在它里面），两段 `<p>` 各留一句。
    const [, span] = articleChildrenOf(parsed);
    const insideSpan = span?.kind === "element" ? span.children : [];
    expect(insideSpan.map((node) => node.kind === "element" && node.tag)).toEqual(["table"]);
    expect(twoPiecesOf(parsed).map((piece) => idOf(piece))).toEqual(["hr-p1", undefined]);
  });
});

describe("closeImplicitParagraphs · 根不是 document（公开类型契约）", () => {
  it("should hand back a non-document root untouched instead of rebuilding it", () => {
    // `ParsedHtml.root` 的类型是 `HtmlNode`（`html/constants.ts:265`），不是 Document：调用方
    // 拿子树当根是类型允许的。这时不能偷偷包一层 document、也不能重建（子树里的 `<p>` 会被拆开）。
    const article = requireElement(bodyOf(parseHtml(QUIRKS_DOC)), "article");
    const parsed: ParsedHtml = { root: article, diagnostics: [] };

    const closed = closeImplicitParagraphs(parsed);

    // 原样返回：同一个 `ParsedHtml`、同一棵子树（重建会换成新节点并包一层 document）。
    expect(closed).toBe(parsed);
    expect(closed.root).toBe(article);
    expect(closed.root.kind).toBe("element");
  });
});
