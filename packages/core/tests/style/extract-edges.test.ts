// 这层管：统计层的边角（空分位、HTML 语料、空词表、非空 examples）；口径本身见 extract-stats。

import { describe, expect, it } from "vitest";

import type { StyleSpec } from "../../src/style/contracts";
import { styleSpecOf } from "../../src/style/extract/compose";
import type { ExtractStats, ExtractStyleInput } from "../../src/style/extract/contracts";
import { markdownParagraphsOf, paragraphTextsOf } from "../../src/style/extract/paragraphs";
import { percentileOf } from "../../src/style/extract/stats";
import { styleYamlOf } from "../../src/style/extract/yaml";
import { parseStyleText } from "../../src/style/spec";

const STATS: ExtractStats = {
  paragraphs: 4,
  sentences: 8,
  averageSentenceChars: 20,
  maxParagraphSentences: 3,
};

const INPUT: ExtractStyleInput = {
  corpus: [{ format: "markdown", text: "一段。二段。" }],
  id: "edge-style",
  name: "边角风格",
  inheritsVisual: "atelier-editorial",
};

const SPEC = styleSpecOf(INPUT, STATS, [], []);

describe("percentileOf · 边界", () => {
  it("should return 0 for an empty sample instead of NaN", () => {
    expect(percentileOf([], 0.75)).toBe(0);
  });

  it("should return the only value when the sample has one element", () => {
    expect(percentileOf([4], 0.75)).toBe(4);
  });
});

describe("markdownParagraphsOf · front matter 边界", () => {
  it("should return nothing for empty text", () => {
    expect(markdownParagraphsOf("")).toEqual([]);
    expect(markdownParagraphsOf("  \n\n")).toEqual([]);
  });

  it("should fall back to a horizontal rule when front matter never closes", () => {
    expect(markdownParagraphsOf("---\ntitle: x")).toEqual(["title: x"]);
  });
});

describe("paragraphTextsOf · HTML 语料", () => {
  it("should take block-level paragraph text and skip empty ones", () => {
    const paragraphs = paragraphTextsOf([
      {
        format: "html",
        text: '<article data-hr-id="hr-a"><h2>标题</h2><p>正文一</p><p> </p><li>列表项</li></article>',
      },
    ]);

    expect(paragraphs).toEqual(["正文一", "列表项"]);
  });

  it("should keep markdown and html corpora in argv order", () => {
    const paragraphs = paragraphTextsOf([
      { format: "markdown", text: "一。" },
      { format: "html", text: '<article data-hr-id="hr-b"><p>二</p></article>' },
    ]);

    expect(paragraphs).toEqual(["一。", "二"]);
  });
});

describe("styleSpecOf · 空词表", () => {
  it("should omit the 常用词 clause when nothing was recommended", () => {
    expect(SPEC.language.persona).toBe("以 20 字左右的句子写作，每段不超过 3 句。");
  });

  it("should keep only the two fixed rules when the corpus has no forbidden hit", () => {
    expect(SPEC.language.narrativeRules).toEqual(["每段控制在 3 句以内", "单句控制在 20 字左右"]);
  });

  it("should quote at most five forbidden words in one rule", () => {
    const spec = styleSpecOf(INPUT, STATS, ["甲", "乙", "丙", "丁", "戊", "己"], ["换句话说"]);

    expect(spec.language.narrativeRules[1]).toBe("避免使用：甲、乙、丙、丁、戊");
    expect(spec.language.persona).toContain("常用词：换句话说。");
  });
});

describe("styleYamlOf · 空列表与非空 examples", () => {
  it("should write [] for empty vocabulary lists instead of a bare key", () => {
    const spec: StyleSpec = {
      ...SPEC,
      language: { ...SPEC.language, vocabulary: { forbidden: [], recommended: [] } },
    };

    const yaml = styleYamlOf(spec);

    expect(yaml).toContain("    forbidden: []");
    expect(yaml).toContain("    recommended: []");
    expect(parseStyleText(yaml, "空词表").language.vocabulary).toEqual({
      forbidden: [],
      recommended: [],
    });
  });

  it("should emit one bad/good pair per example and read back unchanged", () => {
    const spec: StyleSpec = {
      ...SPEC,
      language: {
        ...SPEC.language,
        examples: [
          { bad: "赋能", good: "帮上忙" },
          { bad: "抓手", good: "切入点" },
        ],
      },
    };

    const yaml = styleYamlOf(spec);

    expect(yaml).toContain('    - bad: "赋能"');
    expect(parseStyleText(yaml, "examples").language.examples).toEqual(spec.language.examples);
  });
});
