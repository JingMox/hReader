// 这层管：`hr_read_node` 的选择器文法（4 形态 + 非法拒绝）；不测截断/批注/外壳。

import { describe, expect, it } from "vitest";

import { HrError, parseHtml, readNode } from "../src/index";
import type { ReadNodeResult } from "../src/index";

const DOC =
  '<article data-hr-id="post"><h2 data-hr-id="head">标题</h2>' +
  '<section data-hr-id="s1">一</section><section data-hr-id="s2">二</section>' +
  '<div data-hr-id="wrap"><p data-hr-id="p1">段</p></div>' +
  '<div id="legacy">旧壳</div></article>';

const read = (target: string, html: string = DOC): ReadNodeResult =>
  readNode(parseHtml(html), target);

/** 返回错误码而不是抛：矩阵用例要同时证明 `instanceof HrError` 与 `code`。 */
const codeOf = (target: string, html: string = DOC): string => {
  const error = errorOf(target, html);
  return error instanceof HrError ? error.code : "no-throw";
};

const errorOf = (target: string, html: string = DOC): unknown => {
  try {
    read(target, html);
  } catch (error) {
    return error;
  }
  return undefined;
};

const codesOf = (target: string): readonly string[] =>
  read(target).diagnostics.map((diagnostic) => diagnostic.code);

describe("selector · the four legal shapes", () => {
  it("should resolve #<id> to the element carrying that data-hr-id", () => {
    expect(read("#s2").html).toBe('<section data-hr-id="s2">二</section>');
  });

  it("should treat the three quote variants of [data-hr-id] as the same selector", () => {
    const doubled = read('[data-hr-id="s2"]').html;
    const single = read("[data-hr-id='s2']").html;
    const bare = read("[data-hr-id=s2]").html;

    expect(single).toBe(doubled);
    expect(bare).toBe(doubled);
    expect(doubled).toBe('<section data-hr-id="s2">二</section>');
  });

  it("should treat #<id> and [data-hr-id] as synonyms", () => {
    const byId = read("#s2");
    const byAttribute = read('[data-hr-id="s2"]');

    expect(byId.html).toBe(byAttribute.html);
    expect(byId.annotations).toEqual(byAttribute.annotations);
    expect(byId.diagnostics).toEqual(byAttribute.diagnostics);
  });

  it("should resolve a bare tag to the first element of that tag in document order", () => {
    expect(read("section").html).toBe('<section data-hr-id="s1">一</section>');
  });

  it("should accept an uppercase #id because data-hr-id allows uppercase (D5)", () => {
    // `HR_ID_PATTERN` 允许 `hr-Ab12` 这类大写 id，所以选择器窄文法必须同样收下，不得把 `#hr-Ab12` 判非法。
    const html = '<article data-hr-id="hr-Root"><p data-hr-id="hr-Ab12">正文</p></article>';

    expect(read("#hr-Ab12", html).html).toBe('<p data-hr-id="hr-Ab12">正文</p>');
  });
});

describe("selector · child combinators and nth-of-type", () => {
  it("should resolve a child selector with an explicit index", () => {
    expect(read("div > p:nth-of-type(1)").html).toBe('<p data-hr-id="p1">段</p>');
    expect(read("article>section:nth-of-type(2)").html).toBe(
      '<section data-hr-id="s2">二</section>',
    );
    expect(read("article  >  section:nth-of-type(1)").html).toBe(
      '<section data-hr-id="s1">一</section>',
    );
  });

  it("should count nth-of-type among same-tag siblings, not globally", () => {
    // `<section>` 在 article 里的序号是"同标签第几个"，中间夹 `<div>` 不影响。
    expect(read("article > section:nth-of-type(2)").html).toContain("s2");
    expect(codeOf("article > section:nth-of-type(3)")).toBe("node_not_found");
  });

  it("should ignore a native id that has no data-hr-id", () => {
    expect(codeOf("#legacy")).toBe("node_not_found");
  });

  it("should prefer data-hr-id over a native id on the same element", () => {
    const html = '<div id="legacy" data-hr-id="anchor">双锚</div>';

    expect(read("#anchor", html).html).toBe('<div id="legacy" data-hr-id="anchor">双锚</div>');
    expect(codeOf("#legacy", html)).toBe("node_not_found");
  });
});

describe("selector · the #id synonym trap", () => {
  // 同一文档里 `id="twin"` 与 `data-hr-id="twin"` 落在**不同**元素上，且壳元素在前。
  // 若实现误用原生 id 属性（或 getElementById），就会读到壳元素而不是正文元素 —— 这正是
  // 要封的洞：`#x` 与 `[data-hr-id=x]` 都只认 `data-hr-id`，原生 `id` 完全不参与。
  const TRAP =
    '<article data-hr-id="post"><div id="twin">壳</div><section data-hr-id="twin">正文</section></article>';

  it("should resolve #<id> to data-hr-id even when a native id with the same value comes first", () => {
    const result = read("#twin", TRAP);

    expect(result.html).toBe('<section data-hr-id="twin">正文</section>');
  });

  it("should refuse a native only id instead of falling back to it", () => {
    expect(codeOf("#twin", '<article data-hr-id="post"><div id="twin">壳</div></article>')).toBe(
      "node_not_found",
    );
  });

  it("should match [data-hr-id] strictly on the attribute value", () => {
    expect(read('[data-hr-id="twin"]', TRAP).html).toBe(
      '<section data-hr-id="twin">正文</section>',
    );
  });
});

describe("selector · diagnostics for multiple matches", () => {
  it("should reject a child selector that omits the nth-of-type index", () => {
    expect(codeOf("article > section")).toBe("invalid_selector");
    expect(codeOf("article > section:nth-of-type()")).toBe("invalid_selector");
    expect(codeOf("article > section:nth-of-type(2")).toBe("invalid_selector");
  });

  it("should report ambiguous_selector with the real match count", () => {
    const result = read("section");

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["ambiguous_selector"]);
    expect(result.diagnostics[0]?.message).toContain("命中 2 个元素");
    expect(result.diagnostics[0]?.severity).toBe("warning");
  });

  it("should stay silent when only one element matches", () => {
    expect(codesOf("h2")).toEqual([]);
    expect(codesOf("p")).toEqual([]);
  });
});

interface Illegal {
  readonly input: string;
  readonly why: string;
}

const ILLEGAL: readonly Illegal[] = [
  { input: "", why: "空串" },
  { input: "   ", why: "纯空白" },
  { input: "*", why: "通配" },
  { input: "a,b", why: "逗号并列" },
  { input: "a b", why: "后代选择器" },
  { input: "a > *", why: "子选择器 + 通配" },
  { input: ":not(.x)", why: "伪类" },
  { input: ":first-child", why: "结构性伪类" },
  { input: "[href]", why: "非 data-hr-id 的属性选择器" },
  { input: "[data-hr-id]", why: "缺少值" },
  { input: '[data-hr-id="s1', why: "引号未闭合" },
  { input: '[data-hr-id="s1"', why: "方括号未闭合" },
  { input: '[data-hr-id="s1"]x', why: "尾随垃圾" },
  { input: "article > section:nth-of-type(0)", why: "序号 0" },
  { input: "article > section:nth-of-type(-1)", why: "负序号" },
  { input: "article > section:nth-of-type(1.5)", why: "小数序号" },
  { input: "article > section:nth-of-type(+2)", why: "带符号序号" },
  { input: "article > section:nth-of-type( 2 )", why: "序号内空格" },
  { input: "article > section:nth-of-type(2)x", why: "序号后垃圾" },
  { input: "article >", why: "子选择器缺右侧" },
  { input: "(", why: "裸括号" },
  { input: "#", why: "井号后缺少 id" },
  { input: "#s2 x", why: "id 后尾随" },
  { input: "my-tag", why: "标签名含连字符" },
  { input: "＃s2", why: "全角井号" },
  { input: `#${"a".repeat(200_000)}!`, why: "超长串带尾随垃圾" },
];

describe("selector · illegal grammar is rejected, never degraded", () => {
  it.each(ILLEGAL)("should reject $why as invalid_selector", ({ input }) => {
    expect(codeOf(input)).toBe("invalid_selector");
  });

  it("should keep the thrown error a HrError that survives the public entry", async () => {
    const foreign = await import("@hreader/core");
    const error = errorOf("");

    expect(error).toBeInstanceOf(HrError);
    expect(error).toBeInstanceOf(foreign.HrError);
    expect(error).toHaveProperty("name", "HrError");
    expect(error).toHaveProperty("code", "invalid_selector");
  });
});

describe("selector · missing targets (not a grammar error)", () => {
  it("should throw node_not_found when the grammar is fine but nothing matches", () => {
    expect(codeOf("#nope")).toBe("node_not_found");
    expect(codeOf("table")).toBe("node_not_found");
    expect(codeOf("article > div:nth-of-type(9)")).toBe("node_not_found");
  });

  it("should treat an uppercase #id as a miss, not a grammar error (D5)", () => {
    // `#S2` 文法合法（大写 id 可写），只是文档里只有小写 `s2`，所以是“找不到”而不是“非法”。
    expect(codeOf("#S2")).toBe("node_not_found");
  });
});
