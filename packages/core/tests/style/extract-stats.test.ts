// 这层管：统计层每条口径（段落切分、句数、P75、禁用/推荐词、YAML 形状）；真语料另见 extract-fixtures。

import { describe, expect, it } from "vitest";

import { extractStyle } from "../../src/style/extract";
import { MAX_FORBIDDEN, MAX_RECOMMENDED } from "../../src/style/extract/contracts";
import { markdownParagraphsOf, sentenceCountOf } from "../../src/style/extract/paragraphs";
import {
  averageSentenceCharsOf,
  forbiddenPhrasesOf,
  maxParagraphSentencesOf,
  percentileOf,
  recommendedWordsOf,
} from "../../src/style/extract/stats";
import { styleYamlOf } from "../../src/style/extract/yaml";

const STRUCTURAL = [
  "# 标题",
  "",
  "正文一段。",
  "",
  "| a | b |",
  "|---|---|",
  "",
  "---",
  "",
  "```",
  "code()",
  "```",
  "",
  "[ref]: https://example.com",
  "",
  "正文二段。",
].join("\n");

describe("markdownParagraphsOf · 排除结构行", () => {
  it("should drop headings, tables, rules, fences and reference definitions", () => {
    expect(markdownParagraphsOf(STRUCTURAL)).toEqual(["正文一段。", "正文二段。"]);
  });

  it("should drop lines that are nothing but an html tag", () => {
    const text = ['<div class="note">', "", "正文一段。", "", "</div>"].join("\n");

    expect(markdownParagraphsOf(text)).toEqual(["正文一段。"]);
  });

  it("should skip front matter only when it opens the file", () => {
    expect(markdownParagraphsOf("---\ntitle: x\n---\n正文。")).toEqual(["正文。"]);
    expect(markdownParagraphsOf("正文。\n---\n后文。")).toEqual(["正文。", "后文。"]);
  });
});

describe("markdownParagraphsOf · 段落边界", () => {
  it("should split list items into their own paragraphs and strip the markers", () => {
    expect(markdownParagraphsOf("- 第一条\n- 第二条\n1. 第三条")).toEqual([
      "第一条",
      "第二条",
      "第三条",
    ]);
  });

  it("should join soft-wrapped CJK lines without inserting a space", () => {
    expect(markdownParagraphsOf("中文换行\n接得下去")).toEqual(["中文换行接得下去"]);
  });

  it("should keep one space when joining soft-wrapped ASCII words", () => {
    expect(markdownParagraphsOf("hello\nworld")).toEqual(["hello world"]);
  });
});

describe("sentenceCountOf · 句末口径", () => {
  it("should count CJK terminators and collapse runs of them", () => {
    expect(sentenceCountOf("一。二！三？！四……")).toBe(4);
  });

  it("should not treat a semicolon as a sentence end", () => {
    expect(sentenceCountOf("先说结论；再说理由。")).toBe(1);
  });

  it("should require whitespace or end-of-line after an ASCII period", () => {
    expect(sentenceCountOf("v1.0.1 发布了。")).toBe(1);
    expect(sentenceCountOf("One. Two.")).toBe(2);
  });

  it("should count a question mark as a sentence end on its own", () => {
    // 与"？"连写的情况无关：单独一个"？"也必须收尾，否则整段被读成一句。
    expect(sentenceCountOf("是？否。")).toBe(2);
  });

  it("should count an exclamation mark as a sentence end on its own", () => {
    expect(sentenceCountOf("走！停。")).toBe(2);
  });

  it("should count an unpunctuated paragraph as one sentence", () => {
    expect(sentenceCountOf("没有句号的一段")).toBe(1);
    expect(sentenceCountOf("   ")).toBe(0);
  });
});

describe("percentileOf · 插值", () => {
  it("should interpolate between neighbours", () => {
    expect(percentileOf([1, 2, 3, 4], 0.75)).toBe(3.25);
    expect(percentileOf([2], 0.75)).toBe(2);
  });
});

describe("maxParagraphSentencesOf · P75 与夹取", () => {
  it("should take P75, floor it, and clamp into [2,5]", () => {
    // P75 = 3.25 → floor 3（取 P25 会得到 1，与"上限"语义相反）。
    expect(maxParagraphSentencesOf(["一。", "一。二。", "一。二。三。", "一。二。三。四。"])).toBe(
      3,
    );
  });

  it("should floor an interpolated P75 that lands on .5", () => {
    // 句数 [1,2,5] → position 1.5 → 2 + (5-2)*0.5 = 3.5：floor 得 3，round 会得 4。
    expect(maxParagraphSentencesOf(["一。", "一。二。", "一。二。三。四。五。"])).toBe(3);
  });

  it("should clamp a corpus of very short paragraphs up to 2", () => {
    expect(maxParagraphSentencesOf(["一。", "二。"])).toBe(2);
  });

  it("should clamp a corpus of very long paragraphs down to 5", () => {
    const long = "一。二。三。四。五。六。七。八。";
    expect(maxParagraphSentencesOf([long, long])).toBe(5);
  });
});

describe("averageSentenceCharsOf · 均值", () => {
  it("should divide characters by sentence count and round", () => {
    // 8 个字符 / 2 句 = 4（标点也算在句长里：它占版面的宽度）。
    expect(averageSentenceCharsOf(["一二。三四五六。"])).toBe(4);
  });

  it("should round an average that lands on .5 up", () => {
    // 5 字 / 1 句 + 4 字 / 1 句 = 9 字 2 句 = 4.5：round 得 5，floor 会得 4。
    expect(averageSentenceCharsOf(["一二三四。", "一二三。"])).toBe(5);
  });

  it("should return 0 when there is nothing to average", () => {
    expect(averageSentenceCharsOf(["  "])).toBe(0);
  });
});

describe("forbiddenPhrasesOf · 语料 0 次", () => {
  it("should drop phrases the corpus actually uses and keep the table order", () => {
    const phrases = forbiddenPhrasesOf("其实这事儿很简单");
    expect(phrases).not.toContain("其实");
    expect(phrases[0]).toBe("说实话");
  });

  it("should fill exactly the card §4 cap when the corpus uses no filler at all", () => {
    // F1 的 binding 点是套话表长度本身；F2 的 LLM 追加才真正考验这条上限。
    expect(forbiddenPhrasesOf("").length).toBe(MAX_FORBIDDEN);
  });
});

describe("recommendedWordsOf · 实词 top16", () => {
  it("should rank by frequency, then by codepoint", () => {
    expect(recommendedWordsOf("必须 必须 文件")).toEqual(["必须", "文件"]);
  });

  it("should order ties by codepoint so every machine agrees", () => {
    // 同频按码位升序：文 U+6587 < 断 U+65AD，所以"文件"在前，与出现顺序无关。
    expect(recommendedWordsOf("文件 断言")).toEqual(["文件", "断言"]);
  });

  it("should order equal-frequency ties by code unit, not by locale collation", () => {
    // "是"(U+662F) 码位小于 "最"(U+6700)，ICU 排序却把 "最" 放前面：两种口径在这里分叉。
    expect(recommendedWordsOf("是最，最是。")).toEqual(["是最", "最是"]);
  });

  it("should drop stopword bigrams and non-CJK pairs", () => {
    expect(recommendedWordsOf("因为 所以 必须 hello")).toEqual(["必须"]);
  });

  it("should cap at 16 entries", () => {
    const wide = Array.from({ length: 30 }, (_, index) =>
      String.fromCharCode(0x4e00 + index * 2),
    ).join("");
    expect(recommendedWordsOf(wide).length).toBe(MAX_RECOMMENDED);
  });
});

const RESULT = extractStyle({
  corpus: [{ format: "markdown", text: "第一段。测试测试。\n\n第二段，换句话说是这样。" }],
  id: "unit-style",
  name: "单测风格",
  inheritsVisual: "atelier-editorial",
});

describe("styleYamlOf · 形状", () => {
  it("should quote every scalar and keep a fixed key order", () => {
    const keys = RESULT.yaml
      .split("\n")
      .filter((line) => /^[a-z_]+:/u.test(line))
      .map((line) => line.slice(0, line.indexOf(":")));
    expect(keys).toEqual(["id", "name", "description", "inherits_visual", "language_style"]);
    expect(RESULT.yaml).toContain('id: "unit-style"');
  });

  it("should write an empty examples list explicitly instead of a bare key", () => {
    expect(RESULT.yaml).toContain("  examples: []");
  });

  it("should always produce the deterministic narrative rules template", () => {
    expect(RESULT.spec.language.narrativeRules.length).toBeGreaterThan(0);
    expect(RESULT.spec.language.narrativeRules[0]).toContain("每段控制在");
  });

  it("should keep persona within the 200 character budget", () => {
    expect(RESULT.spec.language.persona.length).toBeLessThanOrEqual(200);
  });
});

describe("styleYamlOf · examples 与确定性", () => {
  it("should reject a corpus with no prose at all", () => {
    expect(() =>
      extractStyle({
        corpus: [{ format: "markdown", text: "# 只有标题\n\n```\ncode\n```" }],
        id: "empty-style",
        name: "空",
        inheritsVisual: "atelier-editorial",
      }),
    ).toThrowError(/没有可统计的正文段落/u);
  });

  it("should be stable across runs (same corpus, same bytes)", () => {
    expect(styleYamlOf(RESULT.spec)).toBe(RESULT.yaml);
  });
});
