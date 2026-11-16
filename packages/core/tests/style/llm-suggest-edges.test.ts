// 这层管：`suggestionsOf` 的长度边界（200/201、120/121、24/25、2/3）与编码容忍（``` 围栏、BOM）；字段丢弃见 llm-suggest。

import { describe, expect, it } from "vitest";

import { suggestionsOf } from "../../src/style/extract";

const responseOf = (content: string): string =>
  JSON.stringify({ choices: [{ message: { content } }] });

const contentOf = (body: unknown): string => JSON.stringify(body);

describe("suggestionsOf · 超长", () => {
  it("should refuse a content body beyond the byte limit", () => {
    const { suggestions, dropped } = suggestionsOf(responseOf("a".repeat(65 * 1024)));

    expect(suggestions).toEqual({ forbidden: [] });
    expect(dropped).toEqual([{ field: "content", reason: "too_long" }]);
  });

  it("should accept persona 200 and drop persona 201", () => {
    const atLimit = suggestionsOf(responseOf(contentOf({ persona: "长".repeat(200) })));
    const overLimit = suggestionsOf(responseOf(contentOf({ persona: "长".repeat(201) })));

    expect(atLimit.suggestions.persona).toHaveLength(200);
    expect(atLimit.dropped).toEqual([]);
    expect(overLimit.suggestions.persona).toBeUndefined();
    expect(overLimit.dropped).toEqual([{ field: "persona", reason: "too_long" }]);
  });
});

describe("suggestionsOf · 围栏与 BOM", () => {
  it("should read a content wrapped in a ```json fence", () => {
    const raw = responseOf(`\`\`\`json\n${contentOf({ persona: "冷峻。" })}\n\`\`\``);

    expect(suggestionsOf(raw).suggestions.persona).toBe("冷峻。");
  });

  it("should read a content that starts with a BOM", () => {
    expect(
      suggestionsOf(responseOf(`\uFEFF${contentOf({ persona: "冷峻。" })}`)).suggestions.persona,
    ).toBe("冷峻。");
  });

  it("should strip both the fence and a BOM inside it", () => {
    const raw = responseOf(`\`\`\`json\n\uFEFF${contentOf({ persona: "冷峻。" })}\n\`\`\``);

    expect(suggestionsOf(raw).suggestions.persona).toBe("冷峻。");
  });
});
