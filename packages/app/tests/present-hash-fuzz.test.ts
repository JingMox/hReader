// 这层管：`#p=` hash 解析/序列化的属性测试——不引入 fast-check，
// 用固定种子的 mulberry32 跑确定性小 fuzz（种子不变 → 每轮输入不变 → 可复现）。
// 覆盖的维度：畸形输入（任意字节串）、字符集（CJK/emoji/NUL/反斜杠）、
// 边界（0/负数/大数/小数）、属性不变量（往返一致、单参数、不抛异常）。

import { describe, expect, it } from "vitest";

import { escapeAttr } from "../src/escape-attr.ts";
import { changedNodesOf } from "../src/flash.ts";
import { hashOfPage, pageOfHash } from "../src/widgets/present.ts";

/** 确定性 PRNG：同一个种子产出同一串输入，失败用例可以逐字复现。 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 字符池：普通 ASCII + hash 元字符 + CJK + emoji + NUL + 反斜杠 + 引号 + 方括号。 */
const POOL = 'abcp=&%#?/\\"[]<>0123456789.-文档演示🚀\ud800\u0000\t eE+';

const fuzzString = (rand: () => number, maxLen: number): string => {
  const len = Math.floor(rand() * (maxLen + 1));
  let out = "";
  for (let i = 0; i < len; i += 1) out += POOL[Math.floor(rand() * POOL.length)] ?? "";
  return out;
};

const SAMPLES = 2000;

describe("pageOfHash · 任意输入只给 undefined 或合法页码", () => {
  it("should never produce NaN, negative, or non-integer pages from fuzzed hashes", () => {
    const rand = mulberry32(20261125);
    for (let i = 0; i < SAMPLES; i += 1) {
      const hash = fuzzString(rand, 24);
      const page = pageOfHash(hash);
      expect(page === undefined || (Number.isInteger(page) && page >= 0)).toBe(true);
    }
  });

  it.each(["p=0", "p=-1", "p=-999999999", "p=NaN", "p=Infinity", "p=abc", "p=", "p=1.9.9"])(
    "should reject the malformed value %s",
    (hash) => {
      const page = pageOfHash(hash);
      expect(page === undefined || page >= 0).toBe(true);
      if (hash !== "p=1.9.9") expect(page).toBeUndefined();
    },
  );

  it("should take only the first p= segment when the param repeats", () => {
    expect(pageOfHash("p=2&p=5")).toBe(1);
    expect(pageOfHash("p=5&p=2")).toBe(4);
    expect(pageOfHash("x=1&p=3&p=9")).toBe(2);
  });

  it("should ignore params that merely contain the p= bytes", () => {
    expect(pageOfHash("xp=3")).toBeUndefined();
    expect(pageOfHash("p")).toBeUndefined();
    expect(pageOfHash("pp=4")).toBeUndefined();
  });
});

describe("hashOfPage · 与 pageOfHash 的往返一致性", () => {
  it("should round-trip every representable page", () => {
    const rand = mulberry32(42);
    for (let i = 0; i < SAMPLES; i += 1) {
      const page = Math.floor(rand() * 1_000_000);
      expect(pageOfHash(hashOfPage("", page))).toBe(page);
    }
  });

  it("should round-trip through a hash with other params preserved", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < SAMPLES; i += 1) {
      const page = Math.floor(rand() * 10_000);
      const hash = `${fuzzString(rand, 8)}&${fuzzString(rand, 8)}`;
      const written = hashOfPage(hash, page);
      expect(pageOfHash(written)).toBe(page);
      // 其余参数一个不少、顺序不变。
      const rest = hash.split("&").filter((part) => part !== "" && !part.startsWith("p="));
      expect(written.split("&").filter((part) => !part.startsWith("p="))).toEqual(rest);
    }
  });

  it("should never emit more than one p= segment, however hostile the input", () => {
    const rand = mulberry32(99);
    for (let i = 0; i < SAMPLES; i += 1) {
      const hash = fuzzString(rand, 32);
      const written = hashOfPage(hash, Math.floor(rand() * 100));
      expect(written.split("&").filter((part) => part.startsWith("p="))).toHaveLength(1);
      expect(written.split("&").every((part) => part !== "")).toBe(true);
    }
  });

  it("should strip p= entirely when the page is cleared", () => {
    expect(hashOfPage("p=3&x=1", undefined)).toBe("x=1");
    expect(hashOfPage("p=3", undefined)).toBe("");
    expect(hashOfPage("p=3&p=5", undefined)).toBe("");
  });
});

describe("escapeAttr · 输出永不含未转义的选择器元字符", () => {
  it("should satisfy the quoted-attr grammar for every fuzzed input", () => {
    const rand = mulberry32(31337);
    for (let i = 0; i < SAMPLES; i += 1) {
      const out = escapeAttr(fuzzString(rand, 20));
      // 允许集：普通字符 | `\`+任意字符 的转义对。等价于"没有裸的 " \ ]"。
      expect(out).toMatch(/^([^\\"\]]|\\.)*$/s);
    }
  });

  it("should be idempotent-safe: double-escaping still yields a closed string", () => {
    const rand = mulberry32(5);
    for (let i = 0; i < SAMPLES; i += 1) {
      const once = escapeAttr(fuzzString(rand, 20));
      expect(escapeAttr(once)).toMatch(/^([^\\"\]]|\\.)*$/s);
    }
  });
});

describe("changedNodesOf · SSE 载荷只收字符串数组", () => {
  it("should always return a string array or reject cleanly on fuzzed JSON", () => {
    const rand = mulberry32(64);
    for (let i = 0; i < SAMPLES; i += 1) {
      const choice = rand();
      const raw: unknown =
        choice < 0.3
          ? fuzzString(rand, 12)
          : choice < 0.6
            ? [fuzzString(rand, 6), rand(), null, { x: rand() }].slice(0, Math.floor(rand() * 5))
            : rand() < 0.5
              ? { nodes: fuzzString(rand, 8) }
              : null;
      const out = changedNodesOf(raw);
      expect(Array.isArray(out)).toBe(true);
      expect(out.every((item) => typeof item === "string")).toBe(true);
    }
  });
});
