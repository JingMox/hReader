// 这层管：模型响应 → `Suggestions` 的逐字段丢弃（坏 JSON、类型错、超长、原型污染）；合并在 llm-merge。

import { describe, expect, it } from "vitest";

import { llmUsableOf, suggestionsOf } from "../../src/style/extract";
import type { Dropped, DroppedReason, LlmPort, Suggestions } from "../../src/style/extract";

const responseOf = (content: string): string =>
  JSON.stringify({ choices: [{ message: { content } }] });

const contentOf = (body: unknown): string => JSON.stringify(body);

const reasonsOf = (dropped: readonly Dropped[]): readonly DroppedReason[] =>
  dropped.map((item) => item.reason);

const VALID = {
  persona: "冷峻，少形容词，喜欢用短句收尾。",
  narrative_rules: ["每段先给结论", "避免排比"],
  rhythm_style: "短句为主，长句只在上文有铺垫时出现",
  examples: [{ bad: "非常重要的", good: "要紧的" }],
  forbidden: ["众所周知"],
};

describe("suggestionsOf · 假 port 回放", () => {
  it("should read a response produced by an LlmPort implementation", async () => {
    const port: LlmPort = { complete: () => Promise.resolve(responseOf(contentOf(VALID))) };
    const raw = await port.complete("prompt");

    const { suggestions }: { readonly suggestions: Suggestions } = suggestionsOf(raw);

    expect(suggestions.persona).toBe(VALID.persona);
    expect(reasonsOf(suggestionsOf(raw).dropped)).toEqual([]);
  });
});

describe("suggestionsOf · 正常响应", () => {
  it("should take every owned field as given", () => {
    const { suggestions, dropped } = suggestionsOf(responseOf(contentOf(VALID)));

    expect(suggestions.persona).toBe(VALID.persona);
    expect(suggestions.narrativeRules).toEqual(VALID.narrative_rules);
    expect(suggestions.rhythmStyle).toBe(VALID.rhythm_style);
    expect(suggestions.examples).toEqual(VALID.examples);
    expect(suggestions.forbidden).toEqual(VALID.forbidden);
    expect(dropped).toEqual([]);
  });

  it("should drop unknown keys and never own the sentence ceiling", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(
        contentOf({
          persona: "冷峻。",
          language_style: { vibes: "quiet" },
          rhythm: { style: "短句", max_paragraph_sentences: 7 },
        }),
      ),
    );

    expect(suggestions.persona).toBe("冷峻。");
    expect(suggestions.rhythmStyle).toBe("短句");
    expect(dropped).toEqual([
      { field: "language_style", reason: "not_owned" },
      { field: "rhythm.max_paragraph_sentences", reason: "not_owned" },
    ]);
  });
});

describe("suggestionsOf · 坏响应不抛", () => {
  it("should return empty suggestions for anything that is not a JSON body", () => {
    for (const raw of [
      "not json at all",
      "{}",
      '{"choices":"nope"}',
      '{"choices":[{"message":"x"}]}',
      '{"choices":[]}',
    ]) {
      const { suggestions, dropped } = suggestionsOf(raw);

      expect(suggestions).toEqual({ forbidden: [] });
      expect(dropped).toEqual([{ field: "choices[0].message.content", reason: "unparsable" }]);
    }
  });

  it("should treat an array content as unparsable rather than guessing", () => {
    const raw = JSON.stringify({ choices: [{ message: { content: [{ text: "hi" }] } }] });

    expect(suggestionsOf(raw).dropped).toEqual([
      { field: "choices[0].message.content", reason: "unparsable" },
    ]);
  });

  it("should treat a content that is not a JSON object as unparsable", () => {
    expect(suggestionsOf(responseOf("[1]")).dropped).toEqual([
      { field: "content", reason: "unparsable" },
    ]);
  });
});

describe("suggestionsOf · 整字段类型错", () => {
  it("should drop fields of the wrong type one by one", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(
        contentOf({ persona: { name: "冷峻" }, narrative_rules: "一条", examples: "bad" }),
      ),
    );

    expect(suggestions.persona).toBeUndefined();
    expect(suggestions.narrativeRules).toBeUndefined();
    expect(suggestions.examples).toBeUndefined();
    expect(dropped).toEqual([
      { field: "persona", reason: "wrong_type" },
      { field: "narrative_rules", reason: "wrong_type" },
      { field: "examples", reason: "wrong_type" },
    ]);
  });
});

describe("suggestionsOf · 原型污染", () => {
  it("should never let a __proto__ key reach Suggestions or Object.prototype", () => {
    const raw = responseOf('{"persona":"冷峻。","__proto__":{"polluted":true}}');
    const { suggestions, dropped } = suggestionsOf(raw);

    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
    // `in` 会穿原型链：内部若用 `Object.assign`/展开把 `__proto__` 拷进来，这条会红。
    expect("polluted" in suggestions).toBe(false);
    expect(suggestions.persona).toBe("冷峻。");
    expect(dropped).toEqual([{ field: "__proto__", reason: "not_owned" }]);
  });
});

describe("suggestionsOf · 逐字段失败臂", () => {
  it("should drop a non-string persona and report the field", () => {
    expect(suggestionsOf(responseOf(contentOf({ persona: 5 }))).dropped).toEqual([
      { field: "persona", reason: "wrong_type" },
    ]);
    expect(suggestionsOf(responseOf(contentOf({ persona: "   " }))).dropped).toEqual([
      { field: "persona", reason: "wrong_type" },
    ]);
  });
});

describe("suggestionsOf · 规则列表", () => {
  it("should drop only the offending item of a rules list", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ narrative_rules: ["先结论", 7, "避免排比"] })),
    );

    expect(suggestions.narrativeRules).toEqual(["先结论", "避免排比"]);
    expect(dropped).toEqual([{ field: "narrative_rules[1]", reason: "wrong_type" }]);
  });

  it("should keep rule 120 and drop rule 121 by index", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ narrative_rules: ["长".repeat(120), "长".repeat(121)] })),
    );

    expect(suggestions.narrativeRules).toEqual(["长".repeat(120)]);
    expect(dropped).toEqual([{ field: "narrative_rules[1]", reason: "too_long" }]);
  });
});

describe("suggestionsOf · 例子", () => {
  it("should drop an example whose side is blank", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ examples: [{ bad: "   ", good: "好" }] })),
    );

    expect(suggestions.examples).toEqual([]);
    expect(dropped).toEqual([{ field: "examples[0]", reason: "wrong_type" }]);
  });

  it("should report an unknown leaf key inside an example instead of eating it", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ examples: [{ bad: "坏", good: "好", note: "备注" }] })),
    );

    expect(suggestions.examples).toEqual([{ bad: "坏", good: "好" }]);
    expect(dropped).toEqual([{ field: "examples[0]", reason: "not_owned" }]);
  });

  it("should drop an example that misses a side or is not an object", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ examples: [{ bad: "很差" }, 5, { bad: "坏", good: "好" }] })),
    );

    expect(suggestions.examples).toEqual([{ bad: "坏", good: "好" }]);
    expect(dropped).toEqual([
      { field: "examples[0]", reason: "wrong_type" },
      { field: "examples[1]", reason: "wrong_type" },
    ]);
  });
});

describe("suggestionsOf · examples 边界：2 收 / 3 丢", () => {
  it("should keep exactly two example pairs without complaint", () => {
    const pair = (index: number) => ({ bad: `坏${String(index)}`, good: `好${String(index)}` });
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ examples: [pair(0), pair(1)] })),
    );

    expect(suggestions.examples).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  it("should keep the first two example pairs and report the overflow", () => {
    const pair = (index: number) => ({ bad: `坏${String(index)}`, good: `好${String(index)}` });
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ examples: [pair(0), pair(1), pair(2)] })),
    );

    expect(suggestions.examples).toEqual([pair(0), pair(1)]);
    expect(dropped).toEqual([{ field: "examples", reason: "too_long" }]);
  });
});

describe("suggestionsOf · 列表上限", () => {
  it("should keep six rules and report the seventh", () => {
    const rules = ["一", "二", "三", "四", "五", "六", "七"];
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ narrative_rules: rules })),
    );

    expect(suggestions.narrativeRules).toEqual(rules.slice(0, 6));
    expect(dropped).toEqual([{ field: "narrative_rules", reason: "too_long" }]);
  });

  it("should keep exactly 24 appended forbidden words without complaint", () => {
    const words = Array.from({ length: 24 }, (_, index) => `套话${String(index)}`);
    const { suggestions, dropped } = suggestionsOf(responseOf(contentOf({ forbidden: words })));

    expect(suggestions.forbidden).toHaveLength(24);
    expect(dropped).toEqual([]);
  });

  it("should keep 24 appended forbidden words and report the 25th", () => {
    const words = Array.from({ length: 25 }, (_, index) => `套话${String(index)}`);
    const { suggestions, dropped } = suggestionsOf(responseOf(contentOf({ forbidden: words })));

    expect(suggestions.forbidden).toHaveLength(24);
    expect(dropped).toEqual([{ field: "forbidden", reason: "too_long" }]);
  });
});

describe("suggestionsOf · rhythm 双键", () => {
  it("should drop a rhythm that is not an object", () => {
    expect(suggestionsOf(responseOf(contentOf({ rhythm: "紧凑" }))).dropped).toEqual([
      { field: "rhythm", reason: "wrong_type" },
    ]);
  });

  it("should drop rhythm.style of the wrong type and unknown rhythm keys", () => {
    expect(suggestionsOf(responseOf(contentOf({ rhythm: { style: 5 } }))).dropped).toEqual([
      { field: "rhythm.style", reason: "wrong_type" },
    ]);
    expect(suggestionsOf(responseOf(contentOf({ rhythm: { vibes: "x" } }))).dropped).toEqual([
      { field: "rhythm.vibes", reason: "not_owned" },
    ]);
  });

  it("should fall back to rhythm.style when the flat key is unusable", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ rhythm_style: "长".repeat(121), rhythm: { style: "散漫" } })),
    );

    expect(suggestions.rhythmStyle).toBe("散漫");
    expect(dropped).toEqual([{ field: "rhythm_style", reason: "too_long" }]);
  });

  it("should let the flat rhythm_style win and mark the nested rhythm as not owned", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ rhythm_style: "紧凑", rhythm: { style: "散漫" } })),
    );

    expect(suggestions.rhythmStyle).toBe("紧凑");
    expect(dropped).toEqual([{ field: "rhythm", reason: "not_owned" }]);
  });
});

describe("llmUsableOf · 判据", () => {
  it("should reject an unparsable response through the all-empty rule", () => {
    const { suggestions } = suggestionsOf("not json at all");

    expect(suggestions).toEqual({ forbidden: [] });
    expect(llmUsableOf(suggestions)).toBe(false);
  });

  it("should reject a suggestion set with all four owned fields empty or blank", () => {
    expect(llmUsableOf({ forbidden: ["众所周知"] })).toBe(false);
    expect(llmUsableOf({ forbidden: [], persona: "", rhythmStyle: "" })).toBe(false);
  });

  it("should accept any single owned field", () => {
    expect(llmUsableOf({ forbidden: [], persona: "冷峻。" })).toBe(true);
    expect(llmUsableOf({ forbidden: [], narrativeRules: ["先结论"] })).toBe(true);
    expect(llmUsableOf({ forbidden: [], rhythmStyle: "短句" })).toBe(true);
    expect(llmUsableOf({ forbidden: [], examples: [{ bad: "坏", good: "好" }] })).toBe(true);
  });
});
