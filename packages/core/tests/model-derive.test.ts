import { describe, expect, it } from "vitest";

import { HrError, injectNodeIds, parseHtml, toDocumentModel } from "../src/index";
import type { DocumentModel } from "../src/index";
import { catchThrown } from "./html-support";

// 模型是 ParsedHtml 的只读投影。本文件只打"派生出来的形状"：
// 文本归属、空白归一、块/内联边界、<br> 词边界、折叠、抛错条件。冻结与校验各自成文件。

const modelOf = (html: string): DocumentModel =>
  toDocumentModel(injectNodeIds(parseHtml(html)).parsed);

/** 未注入的输入（块级元素没有 data-hr-id）用来验证"无 ID 块级元素折叠进父 text"。 */
const rawModelOf = (html: string): DocumentModel => toDocumentModel(parseHtml(html));

const child = (node: DocumentModel, index: number): DocumentModel => {
  const found = node.children[index];
  if (found === undefined) {
    throw new Error(`expected child #${String(index)} under <${node.tag}>`);
  }
  return found;
};

const childrenOf = (node: DocumentModel): readonly DocumentModel[] => [...node.children];

describe("toDocumentModel · 文本归属", () => {
  it("should keep each paragraph's own text when inline elements sit inside", () => {
    const root = modelOf("<article><p>a<span>b</span></p><p>c</p></article>");

    expect(root.tag).toBe("article");
    expect(root.text).toBe("");
    expect(root.children.map((node) => node.text)).toEqual(["ab", "c"]);
  });

  it("should keep nested inline text on the enclosing block only", () => {
    const root = modelOf("<article><p>a<em><strong>b</strong></em></p><p>c</p></article>");

    expect(root.children.map((node) => node.tag)).toEqual(["p", "p"]);
    expect(root.children.map((node) => node.text)).toEqual(["ab", "c"]);
    expect(child(root, 0).children).toEqual([]);
  });

  it("should treat <br> as a word boundary instead of gluing words", () => {
    expect(child(modelOf("<article><p>a<br>b</p></article>"), 0).text).toBe("a b");
  });

  it("should collapse consecutive <br> into a single separator", () => {
    expect(child(modelOf("<article><p>a<br><br>b</p></article>"), 0).text).toBe("a b");
  });
});

describe("toDocumentModel · 文本归属 · 续", () => {
  it("should not derive blocks from inline styling", () => {
    const p = child(modelOf('<article><p>a<span style="display:block">b</span>c</p></article>'), 0);

    expect(p.text).toBe("abc");
    expect(p.children).toEqual([]);
  });

  it("should separate block-subtree text from the sibling text around it", () => {
    const section = child(modelOf("<article><section>lo<p>in</p>hi</section></article>"), 0);

    expect(section.text).toBe("lo hi");
    expect(section.children.map((node) => node.text)).toEqual(["in"]);
  });

  it("should fold block descendants without ids into the parent text", () => {
    const root = rawModelOf('<article data-hr-id="doc"><section>x<p>y</p></section></article>');

    expect(root.text).toBe("x y");
    expect(root.children).toEqual([]);
  });

  // 已知缺陷 D1（P2，已登记 impl 侧不修）：块级子树收尾后紧跟的行内文本会与前一段粘连。
  // 规格要求块边界当词边界（同 <br>），所以 "x<section>y</section>z" 应为 "x y z"；
  // 实现只在"进入"块级时补空格（derive.ts:separateBlock），"离开"时不补，得到 "x yz"。
  // 注入后块级元素都有 id，折叠路径几乎只在未注入输入里可达，故定 P2；修好后本用例会转红，请翻成 it。
  // KD-02
  it.fails("should separate text that follows a folded block subtree", () => {
    const root = rawModelOf('<article data-hr-id="doc"><section>x<p>y</p>z</section></article>');

    expect(root.text).toBe("x y z");
  });

  it("should order children by document order", () => {
    const root = modelOf("<article><p>a</p><ul><li>i</li></ul><p>b</p></article>");

    expect(root.children.map((node) => node.tag)).toEqual(["p", "ul", "p"]);
    expect(child(root, 1).children.map((node) => node.tag)).toEqual(["li"]);
  });
});

describe("toDocumentModel · 空白归一", () => {
  it("should collapse newlines, tabs and runs of spaces", () => {
    expect(child(modelOf("<article><p>a\n\t   b</p></article>"), 0).text).toBe("a b");
  });

  it("should trim leading and trailing whitespace", () => {
    expect(child(modelOf("<article><p>  a  </p></article>"), 0).text).toBe("a");
  });

  it("should collapse NBSP and the ideographic space through the shared parser normaliser", () => {
    // 卡片契约 5 要求复用 src/html/text.ts 的既有归一（\s+），而 \s 含 U+00A0/U+3000，
    // 所以这两类"看起来不是空格"的字符也被压成单空格——这是规格选择，不是本实例的取舍。
    expect(child(modelOf("<article><p>a\u00a0\u3000 b</p></article>"), 0).text).toBe("a b");
  });

  it("should keep the zero width space because \\s does not match it", () => {
    expect(child(modelOf("<article><p>a\u200bb</p></article>"), 0).text).toBe("a\u200bb");
  });

  it("should keep text that only contains spaces empty", () => {
    expect(child(modelOf("<article><p>   </p></article>"), 0).text).toBe("");
  });
});

describe("toDocumentModel · 解码与属性", () => {
  it("should keep decoded characters and no markup residue", () => {
    const text = child(modelOf("<article><p>&amp;&lt;&gt;&quot;</p></article>"), 0).text;

    // 解码后的 `<`/`&` 是正文，残留的"标记"指的是 `&amp;`/`&lt;` 这类实体原文。
    expect(text).toBe('&<>"');
    expect(text.includes("&amp;")).toBe(false);
    expect(text.includes("&lt;")).toBe(false);
  });

  it("should take a whitelisted component value and drop unknown ones", () => {
    const root = modelOf(
      '<article><div data-hr-component="kpi-bento">k</div><div data-hr-component="nope">n</div></article>',
    );

    // 两个 div 都带 component 属性 → 都算块级、都会被注入；白名单外的那个只是不带 component 字段。
    expect(root.children.map((node) => node.tag)).toEqual(["div", "div"]);
    expect(root.children.map((node) => node.component)).toEqual(["kpi-bento", undefined]);
  });

  it("should expose only the contract keys", () => {
    const model = modelOf("<article><p>a</p></article>");

    expect(Object.keys(model).sort()).toEqual(["children", "id", "tag", "text"]);
    expect(Object.keys(child(model, 0)).sort()).toEqual(["children", "id", "tag", "text"]);
  });

  it("should lowercase the tag", () => {
    const root = modelOf("<ARTICLE><P>a</P></ARTICLE>");

    expect(root.tag).toBe("article");
    expect(child(root, 0).tag).toBe("p");
  });
});

describe("toDocumentModel · 不可恢复的问题抛 invalid_document", () => {
  it("should throw when the document has no article", () => {
    const thrown = catchThrown(() => rawModelOf("<div>a</div>"));

    expect(thrown).toBeInstanceOf(HrError);
    expect(thrown instanceof HrError ? thrown.code : undefined).toBe("invalid_document");
  });

  it("should throw when the article was never injected with an id", () => {
    const thrown = catchThrown(() => rawModelOf("<article><p>a</p></article>"));

    expect(thrown instanceof HrError ? thrown.message : "").toContain("data-hr-id");
  });

  it("should throw when a second top-level article makes the root ambiguous", () => {
    const injected = injectNodeIds(parseHtml("<article>a</article><article>b</article>"));
    const thrown = catchThrown(() => toDocumentModel(injected.parsed));

    expect(thrown instanceof HrError ? thrown.message : "").toContain("多个");
  });

  it("should throw for a nested article as well, since the root must be unique", () => {
    const injected = injectNodeIds(parseHtml("<article><article><p>a</p></article></article>"));

    expect(() => toDocumentModel(injected.parsed)).toThrow(HrError);
  });

  it("should use the article's existing data-hr-id as the root id", () => {
    const root = rawModelOf('<article data-hr-id="root-article"><p>a</p></article>');

    expect(root.id).toBe("root-article");
    expect(childrenOf(root).map((node) => node.tag)).toEqual([]);
  });
});
