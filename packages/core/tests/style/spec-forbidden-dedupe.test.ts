// 这层管：`forbidden` 的去重（折叠后同值只留第一条、落盘取 NFC）与它对 lint 命中数的影响。

import { describe, expect, it } from "vitest";

import { lintByStyle } from "../../src/style/lint";
import { parseStyleText } from "../../src/style/spec";

const styleOf = (forbidden: readonly string[]): string =>
  [
    "id: dedupe",
    "description: 去重用。",
    "name: 去重",
    "language_style:",
    "  persona: 只说能核对的话。",
    "  narrative_rules:",
    "    - 一句话只放一个判断。",
    "  vocabulary:",
    "    forbidden:",
    ...forbidden.map((word) => `      - ${word}`),
    "",
  ].join("\n");

const forbiddenOf = (forbidden: readonly string[]): readonly string[] =>
  parseStyleText(styleOf(forbidden), "style.yaml").language.vocabulary.forbidden;

/** 命中里回报的词（不是折叠串）：用户看到的就是它，所以去重后必须仍是词表里那个原文。 */
const hitWordsOf = (forbidden: readonly string[], text: string): readonly string[] => {
  const vocabulary = parseStyleText(styleOf(forbidden), "style.yaml").language.vocabulary;
  return lintByStyle([{ id: "p1", tag: "p", text, children: [] }], vocabulary).hits.map(
    (hit) => hit.word,
  );
};

describe("forbidden 去重", () => {
  it("should treat precomposed and decomposed spellings as one word", () => {
    const words = forbiddenOf(["école", "e\u0301cole"]);

    expect(words).toHaveLength(1);
    expect(words[0]).toBe("école");
  });

  it("should keep the first spelling when a word repeats", () => {
    expect(forbiddenOf(["赋能", "赋能", "赋能"])).toHaveLength(1);
  });
});

describe("forbidden 去重 · 顺序与命中", () => {
  it("should preserve the original order of distinct words", () => {
    expect(forbiddenOf(["赋能", "助力", "赋能", "一站式解决方案"])).toEqual([
      "赋能",
      "助力",
      "一站式解决方案",
    ]);
  });
});

describe("forbidden 去重 · 折叠口径", () => {
  it("should fold full-width and half-width spellings into one word", () => {
    const words = forbiddenOf(["ＡＢＣ", "abc"]);

    expect(words).toEqual(["ＡＢＣ"]);
    expect(hitWordsOf(words, "abc 是缩写")).toEqual(["ＡＢＣ"]);
  });

  it("should fold case differences into one word", () => {
    const words = forbiddenOf(["Abc", "abc"]);

    expect(words).toEqual(["Abc"]);
    expect(hitWordsOf(words, "ABC 是缩写")).toEqual(["Abc"]);
  });

  it("should fold zero-width characters into one word", () => {
    const words = forbiddenOf(["a\u200Bb", "ab"]);

    expect(words).toEqual(["a\u200Bb"]);
    expect(hitWordsOf(words, "ab 连写")).toEqual(["a\u200Bb"]);
  });
});

describe("forbidden 去重 · 命中数", () => {
  it("should report one hit per occurrence instead of one per duplicate entry", () => {
    const vocabulary = parseStyleText(styleOf(["赋能", "赋能", "赋能"]), "style.yaml").language
      .vocabulary;
    const report = lintByStyle(
      [{ id: "p1", tag: "p", text: "先赋能再落地。", children: [] }],
      vocabulary,
    );

    expect(report.hits).toHaveLength(1);
  });
});
