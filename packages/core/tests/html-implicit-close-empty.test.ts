// 隐含结束产生的空段落同样获得 id；已有 `data-hr-id` 保持不变。
// quirks 文档里 `<p data-hr-id="p-1"><table>…</table></p>` 的**首段没有行内内容**。整段丢弃会让
// 作者写在 `<p>` 上的 `data-hr-id` 无处承接、静默消失（`hr read #p-1` 直接 `node_not_found`），
// 因此首段补成零长 span 的空 `<p>` 把原 attrs 留住；**其余**空段没有自己的 id，仍丢弃。
//
// 这层管：解析产树（id 留在哪个 `<p>` 上、零长 span 长什么样、二次收尾不变）、落盘字节、
// `read` 可寻址、`outline` 不列无文本块、以及"第二个无 id 的空段照旧消失"。
// 落盘后的 CLI 删除语义在 `packages/cli/tests/r2-implicit-close-empty.test.ts`。

import { describe, expect, it } from "vitest";

import {
  applyPatch,
  buildOutline,
  HrError,
  injectNodeIds,
  parseHtml,
  readNode,
  serializeHtml,
} from "../src/index";
import { closeImplicitParagraphs } from "../src/html/implicit-close";
import type { HtmlElementNode, HtmlNode, ParsedHtml } from "../src/index";
import { attributeValue, childrenOf, collectElements, requireElement } from "./html-support.test";

const HR_ID = "data-hr-id";
const DOC_WITH_IDS = [
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="p-1">',
  '<table data-hr-id="hr-t"><tr><td data-hr-id="hr-c">1</td></tr></table>',
  '</p><p data-hr-id="p-2">乙</p></article>',
  "</body></html>",
].join("");

/** 判据看的是"`<p>` 里有没有块级元素"而非"直接子节点是不是块级"：块隔着一层 `<b>` 也要认出来。 */
const DOC_WITH_DEEP_BLOCK = [
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="p-1">甲<span data-hr-id="hr-s"><b>',
  "<table><tr><td>1</td></tr></table>",
  "</b></span></p></article></body></html>",
].join("");

/** 反面：`<p>` 里的 `<span>` 只装行内内容，它不算块，行内段照常留着。 */
const DOC_WITH_INLINE_SPAN = [
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="p-1">甲<span data-hr-id="hr-s">乙</span>',
  '<table data-hr-id="hr-t"><tr><td>1</td></tr></table></p></article></body></html>',
].join("");

/** 带一个标题，`outline` 才有东西可列（它只列标题与分节）。 */
const DOC_WITH_HEADING = [
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="p-h">标题</h2><p data-hr-id="p-1">',
  '<table data-hr-id="hr-t"><tr><td data-hr-id="hr-c">1</td></tr></table>',
  "</p></article></body></html>",
].join("");

/** 同一个文档里的**第二个**空段，且它没有 id：它必须照旧消失（不能修成"所有空段都留"）。 */
const DOC_WITH_ID_LESS_EMPTY = [
  "<html><head><title>t</title></head><body>",
  "<article>",
  '<p data-hr-id="p-1"><table data-hr-id="hr-t"><tr><td data-hr-id="hr-c">1</td></tr></table></p>',
  '<p><table data-hr-id="hr-u"><tr><td data-hr-id="hr-d">2</td></tr></table></p>',
  "</article></body></html>",
].join("");

const quirks = (html: string): ParsedHtml => parseHtml(html);

const injectedHtml = (html: string): string => serializeHtml(injectNodeIds(quirks(html)).parsed);

const articleChildrenOf = (parsed: ParsedHtml): readonly HtmlNode[] =>
  childrenOf(
    requireElement(requireElement(requireElement(parsed.root, "html"), "body"), "article"),
  );

const paragraphsOf = (parsed: ParsedHtml): readonly HtmlElementNode[] =>
  articleChildrenOf(parsed).filter(
    (node): node is HtmlElementNode => node.kind === "element" && node.tag === "p",
  );

const tagsOf = (parsed: ParsedHtml): readonly string[] =>
  articleChildrenOf(parsed).map((node) => (node.kind === "element" ? node.tag : node.kind));

/** 文档里所有 `data-hr-id`（按文档序）。 */
const idsOf = (parsed: ParsedHtml): readonly string[] =>
  collectElements(parsed.root)
    .map((element) => attributeValue(element, HR_ID))
    .filter((id): id is string => id !== undefined);

/** `injectNodeIds` 把新诊断并进 `parsed.diagnostics`（没有单独的 diagnostics 字段）。 */
const codesOf = (parsed: ParsedHtml): readonly string[] =>
  injectNodeIds(parsed).parsed.diagnostics.map((diagnostic) => diagnostic.code);

describe("implicitClose · 空首段的 id 归属", () => {
  it("should keep the author id on an empty first piece instead of dropping the paragraph", () => {
    const parsed = quirks(DOC_WITH_IDS);

    // 表格挪出去当兄弟，空首段仍是**一个** `<p>`，id 原样留在它身上。
    expect(tagsOf(parsed)).toEqual(["p", "table", "p"]);
    const [first, second] = paragraphsOf(parsed);
    expect(first === undefined ? undefined : attributeValue(first, HR_ID)).toBe("p-1");
    expect(second === undefined ? undefined : attributeValue(second, HR_ID)).toBe("p-2");
    expect(first === undefined ? undefined : childrenOf(first)).toEqual([]);
  });

  it("should give the empty first piece a zero-length span, which is all the source text it owns", () => {
    const parsed = parseHtml(DOC_WITH_IDS, { locations: true });
    const article = requireElement(parsed.root, "article");
    const first = requireElement(article, "p");
    const table = requireElement(article, "table");

    // 源码里这段 `</p>` 与 `<table>` 之间没有任何字节归它：区间退化成"表开始处的一个点"。
    expect(first.span).toEqual({
      start: table.span?.start,
      end: table.span?.start,
      innerStart: table.span?.start,
      innerEnd: table.span?.start,
    });
  });
});

describe("implicitClose · 空段过滤与幂等", () => {
  it("should drop an id-less empty piece so the fix does not keep every empty paragraph", () => {
    const parsed = quirks(DOC_WITH_ID_LESS_EMPTY);

    // 第二个 `<p>` 没有 id、首段也空：既没有 attrs 可留，也不该凭空多出一个无 id 的空块。
    expect(tagsOf(parsed)).toEqual(["p", "table", "table"]);
    expect(paragraphsOf(parsed)).toHaveLength(1);
    expect(idsOf(parsed)).toEqual(["p-1", "hr-t", "hr-c", "hr-u", "hr-d"]);
  });

  it("should stay idempotent: closing an already split tree changes nothing", () => {
    const once = closeImplicitParagraphs(quirks(DOC_WITH_IDS));
    const twice = closeImplicitParagraphs(once);
    expect(serializeHtml(twice)).toBe(serializeHtml(once));
  });
});

describe("implicitClose · 块级判据的深度", () => {
  it("should find a block nested below an inline wrapper and move the wrapper out", () => {
    const parsed = quirks(DOC_WITH_DEEP_BLOCK);

    // 直接子节点是 `<span><b><table>`：整层 `<span>` 连着里面的块一起挪出去当兄弟，`<p>` 只留行内内容。
    expect(tagsOf(parsed)).toEqual(["p", "span"]);
    const [first] = paragraphsOf(parsed);
    expect(first === undefined ? undefined : attributeValue(first, HR_ID)).toBe("p-1");
  });

  it("should keep an inline-only wrapper inside and split only at the real block", () => {
    const parsed = quirks(DOC_WITH_INLINE_SPAN);

    expect(tagsOf(parsed)).toEqual(["p", "table"]);
    const [first] = paragraphsOf(parsed);
    expect(first === undefined ? undefined : attributeValue(first, HR_ID)).toBe("p-1");
  });
});

describe("落盘 · 空首段的 id", () => {
  it("should write the id back on a paragraph and never report id_reassigned", () => {
    const html = injectedHtml(DOC_WITH_IDS);

    expect(html).toMatch(/<p data-hr-id="p-1"><\/p><table\b/u);
    // id 仍在某个 `<p>` 上：作者的那句话不是被搬到别的元素上"凑数"。
    expect([...html.matchAll(/<p\b[^>]*>/gu)].map(([tag]) => tag)).toEqual([
      '<p data-hr-id="p-1">',
      '<p data-hr-id="p-2">',
    ]);
    expect(codesOf(quirks(DOC_WITH_IDS))).not.toContain("id_reassigned");
  });

  it("should be addressable after landing on disk", () => {
    const parsed = parseHtml(injectedHtml(DOC_WITH_IDS));
    const result = readNode(parsed, "#p-1");

    expect(result.html).toBe('<p data-hr-id="p-1"></p>');
    expect(result.diagnostics).toEqual([]);
  });

  it("should not list the empty block in the outline", () => {
    const parsed = parseHtml(injectedHtml(DOC_WITH_HEADING));
    const outlined = collectOutlinedIds(buildOutline(parsed).nodes);

    // 规则的另一半：拿到 id ≠ 出现在目录里，无文本块不列。
    expect(outlined).toEqual(["p-h"]);
  });
});

interface OutlinedNode {
  readonly id: string;
  readonly children: readonly OutlinedNode[];
}

const collectOutlinedIds = (nodes: readonly OutlinedNode[]): readonly string[] =>
  nodes.flatMap((node) => [node.id, ...collectOutlinedIds(node.children)]);

describe("applyPatch · 未 normalize 的零长空首段", () => {
  it("should reject delete on a zero-span empty paragraph with needs_normalize", () => {
    expect(() => applyPatch(DOC_WITH_IDS, { targetId: "p-1", action: "delete" })).toThrowError(
      HrError,
    );
    expect(() => applyPatch(DOC_WITH_IDS, { targetId: "p-1", action: "delete" })).toThrow(
      /hr normalize --write/u,
    );
  });

  it("should reject replace on a zero-span empty paragraph with needs_normalize", () => {
    expect(() =>
      applyPatch(DOC_WITH_IDS, { targetId: "p-1", action: "replace", html: "<p>新</p>" }),
    ).toThrow(/needs_normalize|hr normalize --write/u);
  });

  it("should allow insert_before on a zero-span empty paragraph", () => {
    const outcome = applyPatch(DOC_WITH_IDS, {
      targetId: "p-1",
      action: "insert_before",
      html: "<p>前</p>",
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.html).toContain(">前</p>");
  });
});
