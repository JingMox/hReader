// Tokenizer unit tests: `Intl.Segmenter("zh")` word segments, word-like parts only,
// lowercased — plus the CJK gate that decides which terms may go fuzzy.

import { describe, expect, it } from "vitest";

import { isCjkTerm, searchTokensOf, tokenizeSearchText } from "../../src/search/tokenize";

const termsOf = (text: string): readonly string[] => tokenizeSearchText(text);

describe("tokenizeSearchText", () => {
  it("splits a Chinese sentence into word segments", () => {
    expect(termsOf("我爱北京天安门")).toEqual(["我", "爱", "北京", "天安门"]);
  });

  it("keeps mixed CJK and latin terms", () => {
    const terms = termsOf("修复 motorcycle 发动机");
    expect(terms).toContain("motorcycle");
    expect(terms).toContain("修复");
  });

  it("drops emoji and punctuation", () => {
    expect(termsOf("修理 🔧 手册！")).toEqual(["修理", "手册"]);
  });

  it("keeps numbers as terms", () => {
    expect(termsOf("版本 3.14 发布")).toEqual(["版本", "3.14", "发布"]);
  });

  it("lowercases every term, latin and full-width alike", () => {
    expect(termsOf("Ｈｅｌｌｏ WORLD")).toEqual(["ｈｅｌｌｏ", "world"]);
  });

  it("returns no terms for pure punctuation and whitespace", () => {
    expect(termsOf("　…—，。！？")).toEqual([]);
  });
});

describe("searchTokensOf", () => {
  it("offsets index the source: slice(start, end) is the segment, lowercased is the term", () => {
    const source = "摩托 Engine 维修";
    for (const token of searchTokensOf(source)) {
      expect(source.slice(token.start, token.end).toLowerCase()).toBe(token.text);
    }
  });
});

describe("property: determinism and case", () => {
  const corpus = [
    "我爱北京天安门",
    "修复 Motorcycle 3.0 发动机",
    "emoji 👋 inside",
    "ｈｅｌｌｏ world",
    "数据库 与 DataBase",
  ];

  it("same input always yields the same token stream", () => {
    for (const text of corpus) {
      expect(tokenizeSearchText(text)).toEqual(tokenizeSearchText(text));
    }
  });

  it("every produced term is already lowercase", () => {
    for (const text of corpus) {
      for (const term of termsOf(text)) {
        expect(term).toBe(term.toLowerCase());
      }
    }
  });
});

describe("isCjkTerm", () => {
  it("marks Han/kana/hangul terms as CJK", () => {
    expect(isCjkTerm("摩托")).toBe(true);
    expect(isCjkTerm("カタカナ")).toBe(true);
    expect(isCjkTerm("한국어")).toBe(true);
  });

  it("treats latin, digits and mixed terms as latin for the fuzzy gate", () => {
    expect(isCjkTerm("motorcycle")).toBe(false);
    expect(isCjkTerm("3.14")).toBe(false);
    expect(isCjkTerm("motor")).toBe(false);
  });
});
