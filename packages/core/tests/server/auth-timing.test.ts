// 这层管：cookie 比较的定长性——"长度不同"也必须真跑一次 `timingSafeEqual`（否则长度从耗时里漏出去）。

import type * as Crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

const calls: { readonly left: number; readonly right: number }[] = [];

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return {
    ...actual,
    timingSafeEqual: (left: Uint8Array, right: Uint8Array): boolean => {
      calls.push({ left: left.length, right: right.length });
      return actual.timingSafeEqual(left, right);
    },
  };
});

const { tokenMatches } = await import("../../src/server/auth");

describe("auth · 定长比较", () => {
  it("should still call timingSafeEqual when the lengths differ", () => {
    calls.length = 0;

    expect(tokenMatches("short", "much-longer-token")).toBe(false);
    expect(calls).toEqual([{ left: 17, right: 17 }]);
  });

  it("should compare the real bytes when the lengths match", () => {
    calls.length = 0;

    expect(tokenMatches("same", "diff")).toBe(false);
    expect(tokenMatches("same", "same")).toBe(true);
    expect(calls).toEqual([
      { left: 4, right: 4 },
      { left: 4, right: 4 },
    ]);
  });
});
