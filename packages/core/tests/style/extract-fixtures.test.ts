// 这层管：`fixtures/extract/` 三篇真语料跑通统计层（字节、真值、产物自洽）；口径本身见 extract-stats。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractStyle } from "../../src/style/extract";
import type { CorpusText } from "../../src/style/extract";
import { parseStyleText } from "../../src/style/spec";

const REPO_ROOT = decodeURIComponent(new URL("../../../../", import.meta.url).pathname);

const pathOf = (name: string): string => `${REPO_ROOT}fixtures/extract/${name}`;

/** 语料是源文档的副本，改 `docs/` 不许让这里的用例红——所以这里钉的是副本自己的字节。 */
const CORPUS_FILES = ["docs-03-section11.md", "docs-05-m33.md", "style-authoring.md"] as const;

/** 真值钉在字节上：语料一改，统计量就没有"真值"可言了。 */
const SHA256: Readonly<Record<string, string>> = {
  "docs-03-section11.md": "d03b0ef233cfb1eed1598735e4aae59b261e68c34b84ae56234fb524753ff622",
  "docs-05-m33.md": "4b421ca7177f48ff3a92e7311930295bb329b3575e81f5324fd8d89ccb075b6f",
  "style-authoring.md": "9a45eac503e9bc96cf155593aad46fcc95f203311e3157cbbc7d54f231348690",
};

const corpusOf = (): readonly CorpusText[] =>
  CORPUS_FILES.map((name) => ({ format: "markdown", text: readFileSync(pathOf(name), "utf8") }));

const CORPUS_TEXT = corpusOf()
  .map((one) => one.text)
  .join("\n");

const EXTRACTED = extractStyle({
  corpus: corpusOf(),
  id: "fixture-style",
  name: "语料风格",
  inheritsVisual: "atelier-editorial",
});

describe("fixtures/extract · 语料字节", () => {
  it("should keep the three corpora byte-identical to their pinned bytes", () => {
    for (const name of CORPUS_FILES) {
      const digest = createHash("sha256")
        .update(readFileSync(pathOf(name)))
        .digest("hex");
      expect({ name, digest }).toEqual({ name, digest: SHA256[name] });
    }
  });
});

describe("extractStyle · 真语料的统计量", () => {
  it("should report exactly the pinned stats", () => {
    expect(EXTRACTED.stats).toEqual({
      paragraphs: 148,
      sentences: 223,
      averageSentenceChars: 79,
      maxParagraphSentences: 2,
    });
  });

  it("should carry max_paragraph_sentences into the spec it emits", () => {
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

  it("should keep every filler phrase the corpus never uses, up to the cap", () => {
    const { forbidden } = EXTRACTED.spec.language.vocabulary;
    expect(forbidden.length).toBe(23);
    for (const phrase of forbidden) expect(CORPUS_TEXT.includes(phrase)).toBe(false);
  });

  it("should cap recommended at 16 entries and keep only phrases the corpus actually uses", () => {
    const { recommended } = EXTRACTED.spec.language.vocabulary;
    expect(recommended.length).toBe(16);
    for (const word of recommended) expect(CORPUS_TEXT.includes(word)).toBe(true);
  });
});
