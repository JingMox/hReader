// 这层管：`annotations/diff.ts` 的字符级 diff（AC4.1）、20 000 上限两侧（AC4.2）与性能边界。
// 退化与否由 `degraded` 单独暴露：只看 chunk 是看不出"跑的是哪条算法"的。

import { describe, expect, it } from "vitest";

import { diffText, DIFF_CHAR_LIMIT, type TextChunk } from "../../src/annotations/diff";

const kindsOf = (chunks: readonly TextChunk[]): string[] =>
  chunks.map((chunk) => `${chunk.kind}:${chunk.text}`);

describe("diffText · 七种形态", () => {
  it("should yield one same chunk for identical input", () => {
    expect(diffText("同一段文字", "同一段文字")).toEqual({
      chunks: [{ kind: "same", text: "同一段文字" }],
      degraded: false,
    });
  });

  it("should mark a pure insertion in the middle", () => {
    expect(kindsOf(diffText("abcd", "abXYcd").chunks)).toEqual(["same:ab", "ins:XY", "same:cd"]);
  });

  it("should mark a pure deletion in the middle", () => {
    expect(kindsOf(diffText("abXYcd", "abcd").chunks)).toEqual(["same:ab", "del:XY", "same:cd"]);
  });

  it("should emit a del/ins pair for a replacement", () => {
    const result = diffText("旧句子", "新句子");

    expect(kindsOf(result.chunks)).toEqual(["del:旧", "ins:新", "same:句子"]);
    expect(result.degraded).toBe(false);
  });

  it("should handle an empty side without emitting zero-length chunks", () => {
    expect(kindsOf(diffText("", "新增").chunks)).toEqual(["ins:新增"]);
    expect(kindsOf(diffText("删除", "").chunks)).toEqual(["del:删除"]);
  });

  it("should keep newlines inside chunks across lines", () => {
    const result = diffText("alpha\nbeta", "alpha\nBETA");

    expect(kindsOf(result.chunks)).toEqual(["same:alpha\n", "del:beta", "ins:BETA"]);
    expect(result.chunks.every((chunk) => chunk.text !== "")).toBe(true);
  });

  it("should diff non-ASCII text by code unit without mangling it", () => {
    expect(kindsOf(diffText("café", "cafè").chunks)).toEqual(["same:caf", "del:é", "ins:è"]);
  });
});

const long = "a".repeat(DIFF_CHAR_LIMIT);
const longer = "a".repeat(DIFF_CHAR_LIMIT + 1);

describe("diffText · 20 000 字符上限", () => {
  it("should pin the limit at exactly 20 000", () => {
    expect(DIFF_CHAR_LIMIT).toBe(20_000);
  });

  it("should still run the character-level algorithm at 19 999", () => {
    const result = diffText(long.slice(0, DIFF_CHAR_LIMIT - 1), "b");

    expect(result.degraded).toBe(false);
    expect(result.chunks).toEqual([
      { kind: "del", text: long.slice(0, DIFF_CHAR_LIMIT - 1) },
      { kind: "ins", text: "b" },
    ]);
  });

  it("should not degrade at exactly 20 000", () => {
    expect(diffText(long, "b").degraded).toBe(false);
  });
});

describe("diffText · 单侧超限与性能", () => {
  it("should degrade a single-sided 20k edit (char gate is per side)", () => {
    // 单侧超 20 000 就降级：`tooLong` 看的是两侧各自长度，不是总和。
    const result = diffText(longer, "b");

    expect(result.degraded).toBe(true);
    expect(result.chunks.map((chunk) => chunk.kind)).toEqual(["del", "ins"]);
  });

  it("should degrade on the cell budget while both sides stay under 20 000", () => {
    // 3 000 × 3 000 → (3001)² = 9 006 001 > 8M；两侧都远低于字符闸，只有格子闸能拦住。
    const result = diffText("x".repeat(3_000), "y".repeat(3_000));

    expect(result.degraded).toBe(true);
    expect(result.chunks.map((chunk) => chunk.kind)).toEqual(["del", "ins"]);
  });

  it("should degrade once (n+1)*(m+1) crosses 8M cells", () => {
    const wide = "x".repeat(4_000_000);
    const result = diffText(wide, "y");

    expect(result.degraded).toBe(true);
    expect(result.chunks.map((chunk) => chunk.kind)).toEqual(["del", "ins"]);
  });

  it("should return 20k inputs in under 200ms (degraded path is O(n))", () => {
    const before = Array.from({ length: 40 }, (_, i) => `第${String(i)}行`).join("\n");
    const padded = `${before}${"x".repeat(DIFF_CHAR_LIMIT - before.length + 1)}`;
    const after = `${padded.slice(0, -1)}y`;
    const started = performance.now();
    const result = diffText(padded, after);
    const elapsed = performance.now() - started;

    expect(result.degraded).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("diffText · 回填分支", () => {
  it("should prefer a pure insertion when it keeps more characters", () => {
    expect(diffText("b", "ab")).toEqual({
      chunks: [
        { kind: "ins", text: "a" },
        { kind: "same", text: "b" },
      ],
      degraded: false,
    });
  });

  it("should keep equal paragraphs as same in the degraded path", () => {
    const line = "重复行\n";
    const before = `${line}${"a".repeat(20_001)}`;
    const after = `${line}${"b".repeat(20_001)}`;
    const result = diffText(before, after);

    expect(result.degraded).toBe(true);
    expect(result.chunks[0]).toEqual({ kind: "same", text: line });
    expect(kindsOf(result.chunks)).toContain("del:" + "a".repeat(20_001));
  });
});
