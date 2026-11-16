// 这层管：统计权威与模型建议的合并边界（数值独断、forbidden 去重保序与上限、空数组不抹）；解析另见 llm-suggest。

import { describe, expect, it } from "vitest";

import type { StyleSpec } from "../../src/style/contracts";
import { MAX_FORBIDDEN } from "../../src/style/extract/contracts";
import { mergeSuggestions } from "../../src/style/extract";
import type { Suggestions } from "../../src/style/extract";

const FILLERS = ["其实", "显而易见"];

const statOf = (overrides?: Partial<StyleSpec["language"]>): StyleSpec => ({
  id: "corpus",
  name: "语料",
  description: "统计版",
  inheritsVisual: "atelier-editorial",
  language: {
    persona: "统计版人格",
    narrativeRules: ["每段控制在 3 句以内"],
    rhythm: { maxParagraphSentences: 3, style: "平均句长约 24 字" },
    vocabulary: { forbidden: FILLERS, recommended: ["要紧"] },
    examples: [{ bad: "非常重要", good: "要紧" }],
    ...overrides,
  },
});

const suggestionsOf = (extra: Partial<Suggestions>): Suggestions => ({ forbidden: [], ...extra });

describe("mergeSuggestions · 数值权威", () => {
  it("should keep the statistical sentence ceiling even when the model disagrees", () => {
    const merged = mergeSuggestions(statOf(), suggestionsOf({ narrativeRules: ["先结论后解释"] }), [
      { field: "rhythm.max_paragraph_sentences", reason: "not_owned" },
    ]);

    expect(merged.spec.language.rhythm.maxParagraphSentences).toBe(3);
    expect(merged.spec.language.narrativeRules).toEqual(["先结论后解释"]);
    expect(merged.dropped).toEqual([
      { field: "rhythm.max_paragraph_sentences", reason: "not_owned" },
    ]);
  });

  it("should never touch recommended words nor the identity fields", () => {
    const merged = mergeSuggestions(statOf(), suggestionsOf({ persona: "冷峻。" }), []);

    expect(merged.spec.language.vocabulary.recommended).toEqual(["要紧"]);
    expect(merged.spec.id).toBe("corpus");
    expect(merged.spec.inheritsVisual).toBe("atelier-editorial");
  });
});

describe("mergeSuggestions · forbidden 并集", () => {
  it("should dedupe with the statistical table first and keep response order", () => {
    const merged = mergeSuggestions(
      statOf(),
      suggestionsOf({ forbidden: ["显而易见", "话说", "其实", "说白了"] }),
      [],
    );

    expect(merged.spec.language.vocabulary.forbidden).toEqual([
      "其实",
      "显而易见",
      "话说",
      "说白了",
    ]);
    expect(merged.dropped).toEqual([]);
  });

  it("should cap the union at 24 and report the overflow", () => {
    const full = Array.from({ length: MAX_FORBIDDEN }, (_, index) => `套话${String(index)}`);
    const merged = mergeSuggestions(
      statOf({ vocabulary: { forbidden: full, recommended: [] } }),
      suggestionsOf({ forbidden: ["第25条"] }),
      [],
    );

    expect(merged.spec.language.vocabulary.forbidden).toHaveLength(MAX_FORBIDDEN);
    expect(merged.spec.language.vocabulary.forbidden).not.toContain("第25条");
    expect(merged.dropped).toEqual([{ field: "forbidden", reason: "too_long" }]);
  });
});

describe("mergeSuggestions · 空数组不抹掉统计版", () => {
  it("should keep the statistical examples when the model sends an empty array", () => {
    const merged = mergeSuggestions(
      statOf(),
      suggestionsOf({ examples: [], narrativeRules: [] }),
      [],
    );

    expect(merged.spec.language.examples).toEqual([{ bad: "非常重要", good: "要紧" }]);
    expect(merged.spec.language.narrativeRules).toEqual(["每段控制在 3 句以内"]);
  });

  it("should take the model examples when it does send some", () => {
    const merged = mergeSuggestions(
      statOf(),
      suggestionsOf({ examples: [{ bad: "极大", good: "大" }] }),
      [],
    );

    expect(merged.spec.language.examples).toEqual([{ bad: "极大", good: "大" }]);
  });
});
