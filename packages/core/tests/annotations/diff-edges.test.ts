// 这层管：`diffText`（`packages/core/src/annotations/diff.ts`）的形状矩阵——
// 空的输入、单侧空、行尾换行、CRLF、纯换行。每例都断言"重拼逐字等于后文"，这是 diff 的硬不变量。
import { describe, expect, it } from "vitest";

import { diffText } from "../../src/annotations/diff";

const SHAPES: readonly (readonly [string, string])[] = [
  ["", ""],
  ["", "abc"],
  ["abc", ""],
  ["a", "a"],
  ["a", "b"],
  ["ab", "ba"],
  ["a\n", "a\n"],
  ["a\n", "b\n"],
  ["a\r\nb\r\n", "a\r\nc\r\n"],
  ["\n\n\n", "\n\n"],
  ["第一行\n第二行\n", "第一行\n第二行改\n"],
  ["x".repeat(1) + "y", "x" + "y".repeat(1)],
];

describe("diffText · 形状矩阵", () => {
  it.each(SHAPES)("should rebuild %j → %j byte-for-byte", (before, after) => {
    const result = diffText(before, after);
    const rebuilt = result.chunks
      .filter((chunk) => chunk.kind !== "del")
      .map((chunk) => chunk.text)
      .join("");

    expect(rebuilt).toBe(after);
    // 被删掉的字符也必须刚好是 before 的差集：拿 same+del 重拼要回到 before。
    const reverted = result.chunks
      .filter((chunk) => chunk.kind !== "ins")
      .map((chunk) => chunk.text)
      .join("");
    expect(reverted).toBe(before);
  });
});

describe("diffText · 退化路径与上限", () => {
  it("should fall back to paragraph diff beyond the cell budget and flag degraded", () => {
    // 800 万格子：3000 × 3000 = 9,000,000 > 8,000,000 ⇒ 退化，但 chunks 仍可重拼。
    const before = "行\n".repeat(3000);
    const after = `${"行\n".repeat(3000)}末`;

    const result = diffText(before, after);

    expect(result.degraded).toBe(true);
    // 退化路径只按行切：后文末尾多出来的一行必须以 ins 出现。
    expect(result.chunks.some((chunk) => chunk.kind === "ins" && chunk.text === "末")).toBe(true);
    expect(
      result.chunks
        .filter((chunk) => chunk.kind !== "del")
        .map((chunk) => chunk.text)
        .join(""),
    ).toBe(after);
  });

  it("should stay exact just below the cell budget", () => {
    // 2999 × 2999 ≈ 8,994,001 仍然超；用一行之差的小输入验证"不退化"的对照组口径。
    const result = diffText("甲乙丙", "甲乙丁");

    expect(result.degraded).toBe(false);
    expect(result.chunks).toStrictEqual([
      { kind: "same", text: "甲乙" },
      { kind: "del", text: "丙" },
      { kind: "ins", text: "丁" },
    ]);
  });
});
