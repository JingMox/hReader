// 这层管：归一化（大小写/全角/零宽）与偏移语义——偏移是块内 UTF-16 码元，切片必须落在原文本上。

import { describe, expect, it } from "vitest";

import type { DocumentModel } from "../../src/model";
import { lintByStyle } from "../../src/style/lint";

const VOCAB = (forbidden: readonly string[], recommended: readonly string[] = []) => ({
  forbidden,
  recommended,
});

const node = (id: string, text: string): DocumentModel => ({ id, tag: "p", text, children: [] });

describe("lintByStyle · 归一化", () => {
  it("should match Latin case-insensitively and keep the original offset", () => {
    const report = lintByStyle([node("n1", "a BOOM here")], VOCAB(["boom"]));

    expect(report.hits).toEqual([{ path: "n1", word: "boom", excerpt: "a BOOM here", offset: 2 }]);
  });

  it("should match full-width forms against half-width vocabulary (NFKC)", () => {
    expect(lintByStyle([node("n1", "ＢＯＯＭ！")], VOCAB(["boom"])).hits[0]?.offset).toBe(0);
    expect(lintByStyle([node("n1", "指标 ＫＰＩ")], VOCAB(["kpi"])).hits[0]?.offset).toBe(3);
  });

  it("should ignore zero-width characters on both sides", () => {
    const text = "赋\u200b能和赋\u00ad能";

    expect(lintByStyle([node("n1", text)], VOCAB(["赋能"])).hits.map((hit) => hit.offset)).toEqual([
      0, 4,
    ]);
    expect(lintByStyle([node("n1", "赋能")], VOCAB(["\u200b赋能"])).hits).toHaveLength(1);
  });

  it("should treat a word that folds to nothing as unusable, not as a wildcard", () => {
    expect(lintByStyle([node("n1", "任何文本")], VOCAB(["\u200b"])).hits).toEqual([]);
  });

  it("should fold NFKC expansions and still point at the original character", () => {
    const hit = lintByStyle([node("n1", "前缀 ㍿")], VOCAB(["株式会社"])).hits[0];

    expect(hit?.offset).toBe(3);
    expect(hit?.excerpt).toContain("㍿");
  });

  it("should match a multi-word phrase inside the block", () => {
    const hit = lintByStyle([node("n1", "我们应当闭环这个抓手")], VOCAB(["闭环这个抓手"])).hits[0];

    expect(hit?.offset).toBe(4);
    expect(hit?.word).toBe("闭环这个抓手");
  });
});

describe("lintByStyle · 偏移语义（UTF-16 码元）", () => {
  it("should count CJK characters as one unit each", () => {
    expect(lintByStyle([node("n1", "一二三禁用")], VOCAB(["禁用"])).hits[0]?.offset).toBe(3);
  });

  it("should count an emoji as two units so later hits stay aligned", () => {
    expect(lintByStyle([node("n1", "😀禁用")], VOCAB(["禁用"])).hits[0]?.offset).toBe(2);
    expect(lintByStyle([node("n1", "😀😀禁用")], VOCAB(["禁用"])).hits[0]?.offset).toBe(4);
  });

  it("should keep the offset equal to indexOf and cut the excerpt safely", () => {
    const text = `${"😀".repeat(16)}禁用`;
    const hit = lintByStyle([node("n1", text)], VOCAB(["禁用"])).hits[0];

    expect(hit?.offset).toBe(text.indexOf("禁用"));
    expect(hit?.excerpt.startsWith("…")).toBe(true);
    expect(hit?.excerpt).toContain("禁用");
  });
});
