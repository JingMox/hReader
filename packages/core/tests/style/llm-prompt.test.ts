// 这层管：提示词的字节稳定性、语料截断与字段齐备（F2 约束 5）；模型响应另见 llm-suggest。

import { describe, expect, it } from "vitest";

import {
  PROMPT_MAX_CORPUS_BYTES,
  corpusBlockOf,
  extractStyle,
  promptOf,
} from "../../src/style/extract";
import type { CorpusBlock, CorpusText, ExtractStats, PromptInput } from "../../src/style/extract";

const STATS: ExtractStats = {
  paragraphs: 12,
  sentences: 37,
  averageSentenceChars: 24,
  maxParagraphSentences: 3,
};

const CORPUS: readonly CorpusText[] = [
  { format: "markdown", text: "第一篇语料。它有两句。" },
  { format: "markdown", text: "第二篇语料。" },
];

const INPUT: PromptInput = { stats: STATS, corpus: CORPUS };

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

describe("promptOf · 字节稳定", () => {
  it("should be byte-identical across calls and carry no clock or random id", () => {
    const first = promptOf(INPUT);
    const second = promptOf(INPUT);

    expect(second).toBe(first);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    expect(first).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });
});

describe("promptOf · 语料截断", () => {
  it("should truncate an oversized corpus at the byte limit and report it", () => {
    const filler = "长".repeat(PROMPT_MAX_CORPUS_BYTES);
    const block: CorpusBlock = corpusBlockOf([{ format: "markdown", text: `${filler}尾部标记` }]);

    expect(bytesOf(block.text)).toBeLessThanOrEqual(PROMPT_MAX_CORPUS_BYTES);
    expect(block.text).not.toContain("尾部标记");
    expect(block.dropped).toEqual([{ field: "corpus", reason: "too_long" }]);
  });

  it("should keep a small corpus intact and report nothing", () => {
    const block = corpusBlockOf(CORPUS);

    expect(block.text).toBe(CORPUS.map((doc) => doc.text).join("\n\n"));
    expect(block.dropped).toEqual([]);
  });
});

describe("promptOf · 字段齐备", () => {
  it("should carry every stat value, both documents in order, and the allowed keys", () => {
    const prompt = promptOf(INPUT);

    expect(prompt).toContain("段落数：12");
    expect(prompt).toContain("句数：37");
    expect(prompt).toContain("平均句长：24 字");
    expect(prompt).toContain("每段句数上限：3 句");
    expect(prompt.indexOf("第一篇语料")).toBeLessThan(prompt.indexOf("第二篇语料"));
    for (const key of ["persona", "narrative_rules", "rhythm_style", "examples", "forbidden"]) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  it("should render the real stats of a real extraction without placeholders", () => {
    const { stats } = extractStyle({
      corpus: [{ format: "markdown", text: "第一句。第二句。\n\n只有一句。" }],
      id: "corpus",
      name: "语料",
      inheritsVisual: "atelier-editorial",
    });
    const prompt = promptOf({ stats, corpus: [{ format: "markdown", text: "第一句。第二句。" }] });

    expect(prompt).toContain(`每段句数上限：${String(stats.maxParagraphSentences)} 句`);
    for (const placeholder of ["TODO", "<...>", "undefined", "NaN"]) {
      expect(prompt).not.toContain(placeholder);
    }
  });
});
