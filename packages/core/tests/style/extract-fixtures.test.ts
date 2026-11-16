// 这层管：`fixtures/extract/` 三篇真语料跑通统计层（产物能过严格解析器、规则与语料自洽）。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractStyle } from "../../src/style/extract";
import type { CorpusText } from "../../src/style/extract";
import { parseStyleText } from "../../src/style/spec";

const REPO_ROOT = decodeURIComponent(new URL("../../../../", import.meta.url).pathname);

/** 卡 §10 R8：语料是源文档的副本，改 `docs/` 不许让本卡用例红。 */
const CORPUS_FILES = ["docs-03-section11.md", "docs-05-m33.md", "style-authoring.md"] as const;

const corpusOf = (): readonly CorpusText[] =>
  CORPUS_FILES.map((name) => ({
    format: "markdown",
    text: readFileSync(`${REPO_ROOT}fixtures/extract/${name}`, "utf8"),
  }));

const CORPUS_TEXT = corpusOf()
  .map((one) => one.text)
  .join("\n");

const EXTRACTED = extractStyle({
  corpus: corpusOf(),
  id: "fixture-style",
  name: "语料风格",
  inheritsVisual: "atelier-editorial",
});

describe("extractStyle · 真语料的统计量", () => {
  it("should find a plausible amount of prose in the three fixtures", () => {
    expect(EXTRACTED.stats.paragraphs).toBeGreaterThan(100);
    expect(EXTRACTED.stats.sentences).toBeGreaterThan(EXTRACTED.stats.paragraphs);
    expect(EXTRACTED.stats.averageSentenceChars).toBeGreaterThan(10);
  });

  it("should keep max_paragraph_sentences inside the card §4 band", () => {
    expect(EXTRACTED.stats.maxParagraphSentences).toBeGreaterThanOrEqual(2);
    expect(EXTRACTED.stats.maxParagraphSentences).toBeLessThanOrEqual(5);
    expect(EXTRACTED.spec.language.rhythm.maxParagraphSentences).toBe(
      EXTRACTED.stats.maxParagraphSentences,
    );
  });

  it("should report the corpus size it was given", () => {
    expect(EXTRACTED.spec.description).toContain("3 篇语料");
    expect(EXTRACTED.spec.description).toContain(`${String(EXTRACTED.stats.paragraphs)} 个段落`);
  });
});

describe("extractStyle · 真语料的产物", () => {
  it("should emit yaml that the strict parser reads back unchanged", () => {
    const spec = parseStyleText(EXTRACTED.yaml, "提取产物");
    expect(spec.id).toBe("fixture-style");
    expect(spec.language).toEqual(EXTRACTED.spec.language);
  });

  it("should cap forbidden at 24 entries and keep only phrases the corpus never uses", () => {
    const { forbidden } = EXTRACTED.spec.language.vocabulary;
    expect(forbidden.length).toBeLessThanOrEqual(24);
    expect(forbidden.length).toBeGreaterThan(0);
    for (const phrase of forbidden) expect(CORPUS_TEXT.includes(phrase)).toBe(false);
  });

  it("should cap recommended at 16 entries and keep only phrases the corpus actually uses", () => {
    const { recommended } = EXTRACTED.spec.language.vocabulary;
    expect(recommended.length).toBe(16);
    for (const word of recommended) expect(CORPUS_TEXT.includes(word)).toBe(true);
  });
});
