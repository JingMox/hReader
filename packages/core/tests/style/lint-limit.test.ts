// 这层管：`LINT_HIT_LIMIT` 的边界语义——每块各自截断，总量不跨块共享预算。

import { describe, expect, it } from "vitest";

import type { DocumentModel } from "../../src/model";
import { LINT_HIT_LIMIT, lintByStyle } from "../../src/style/lint";

const VOCAB = { forbidden: ["赋能"], recommended: [] };

const node = (id: string, text: string): DocumentModel => ({ id, tag: "p", text, children: [] });

const repeats = (count: number): string => Array.from({ length: count }, () => "赋能").join(" ");

describe("lintByStyle · 单块边界", () => {
  it.each([
    ["正好上限（100）", LINT_HIT_LIMIT, LINT_HIT_LIMIT, false],
    ["超过上限（101）", LINT_HIT_LIMIT + 1, LINT_HIT_LIMIT, true],
  ])("should mark %s as %i hits with truncated=%s", (_label, occurrences, expected, truncated) => {
    const report = lintByStyle([node("n1", repeats(occurrences))], VOCAB);

    expect(report.hits).toHaveLength(expected);
    expect(report.truncated).toBe(truncated);
    expect(report.hits.at(-1)?.offset).toBe(repeats(expected).length - 2);
  });
});

describe("lintByStyle · 多块组合", () => {
  it("should set truncated when one block overflows even if the other is small", () => {
    const report = lintByStyle([node("a", repeats(60)), node("b", repeats(101))], VOCAB);

    expect(report.hits).toHaveLength(160);
    expect(report.truncated).toBe(true);
    expect(report.hits.at(-1)?.path).toBe("b");
  });

  it("should not set truncated when every block stays under the limit", () => {
    const report = lintByStyle([node("a", repeats(60)), node("b", repeats(40))], VOCAB);

    expect(report.hits).toHaveLength(100);
    expect(report.truncated).toBe(false);
  });

  it("should keep per-block order and count when a later block is truncated", () => {
    const report = lintByStyle([node("a", repeats(2)), node("b", repeats(120))], VOCAB);

    expect(report.hits[0]?.path).toBe("a");
    expect(report.hits.filter((hit) => hit.path === "a")).toHaveLength(2);
    expect(report.hits.filter((hit) => hit.path === "b")).toHaveLength(LINT_HIT_LIMIT);
    expect(report.truncated).toBe(true);
  });
});
