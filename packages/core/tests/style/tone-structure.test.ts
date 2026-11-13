// 这层管：`compileTone` 的固定骨架、确定性与空值约定（不验语气好坏，只验可复现）。

import { describe, expect, it } from "vitest";

import { compileTone } from "../../src/style/tone";
import { sectionHeadings, TONE_SPEC, withLanguage } from "./harness";

describe("compileTone · 骨架与确定性", () => {
  it("should emit the fixed section order, one trailing newline", () => {
    const markdown = compileTone(TONE_SPEC);

    expect(sectionHeadings(markdown)[0]).toBe("# 语言风格：安静的书记员（id: quiet-clerk）");
    expect(sectionHeadings(markdown).slice(1)).toEqual([
      "## 人设",
      "## 叙事规则",
      "## 节奏约束",
      "## 推荐用词",
      "## 禁用词",
      "## 示例",
      "### 示例 1 · 反例",
      "### 示例 1 · 正例",
    ]);
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });

  it("should be byte-stable across repeated compiles", () => {
    expect(compileTone(TONE_SPEC)).toBe(compileTone(TONE_SPEC));
  });
});

describe("compileTone · 条目渲染", () => {
  it("should render one numbered blockquote per narrative rule", () => {
    const markdown = compileTone(withLanguage({ narrativeRules: ["甲。", "乙。", "丙。"] }));

    expect(markdown).toContain("1.\n   > 甲。");
    expect(markdown).toContain("2.\n   > 乙。");
    expect(markdown).toContain("3.\n   > 丙。");
  });

  it("should render one bad/good pair per example, in order", () => {
    const markdown = compileTone(
      withLanguage({
        examples: [
          { bad: "差一", good: "好一" },
          { bad: "差二", good: "好二" },
        ],
      }),
    );
    const at = (part: string): number => markdown.indexOf(part);

    expect(at("### 示例 1 · 反例")).toBeLessThan(at("差一"));
    expect(at("差一")).toBeLessThan(at("### 示例 1 · 正例"));
    expect(at("好一")).toBeLessThan(at("### 示例 2 · 反例"));
    expect(at("差二")).toBeLessThan(at("好二"));
  });
});

describe("compileTone · 空值约定", () => {
  it("should use the explicit empty markers for rules/vocabulary/examples", () => {
    const markdown = compileTone(
      withLanguage({
        narrativeRules: [],
        vocabulary: { forbidden: [], recommended: [] },
        examples: [],
      }),
    );

    expect(markdown).toContain("- （无额外规则）");
    expect(markdown.match(/- （无）/gu)).toHaveLength(3);
    expect(markdown).not.toContain("### 示例");
  });

  it("should skip the rhythm line for the empty 'unconstrained' sentinel", () => {
    const markdown = compileTone(withLanguage({ rhythm: { maxParagraphSentences: 4, style: "" } }));

    expect(markdown).toContain("- 每个自然段最多 4 句。");
    expect(markdown).not.toContain("- 句式：");
  });

  it("should fold a multi-line rhythm style onto one line", () => {
    const markdown = compileTone(
      withLanguage({ rhythm: { maxParagraphSentences: 3, style: "短句。\n\n再短一点。" } }),
    );

    expect(markdown).toContain("- 句式：短句。 再短一点。");
    expect(markdown).not.toContain("句式：短句。\n");
  });
});
