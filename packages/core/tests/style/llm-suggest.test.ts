// 这层管：模型响应 → `Suggestions` 的逐字段丢弃（坏 JSON、类型错、超长、原型污染）；合并在 llm-merge。

import { describe, expect, it } from "vitest";

import { suggestionsOf } from "../../src/style/extract";
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

describe("suggestionsOf · 超长", () => {
  it("should refuse a content body beyond the byte limit", () => {
    const { suggestions, dropped } = suggestionsOf(responseOf("a".repeat(65 * 1024)));

    expect(suggestions).toEqual({ forbidden: [] });
    expect(dropped).toEqual([{ field: "content", reason: "too_long" }]);
  });

  it("should drop an over-long persona instead of truncating it", () => {
    const { suggestions, dropped } = suggestionsOf(
      responseOf(contentOf({ persona: "长".repeat(201) })),
    );

    expect(suggestions.persona).toBeUndefined();
    expect(dropped).toEqual([{ field: "persona", reason: "too_long" }]);
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
