// This layer covers `text/truncate.ts`'s code-point cut: unit edges (limits, surrogate pairs,
// pre-existing lone surrogates) plus the property contract over arbitrary strings.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { cutAtCodePoint } from "../src/text/truncate";

const LONE_LEAD = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u;
const LONE_TAIL = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe("cutAtCodePoint · unit edges", () => {
  it("should return an empty string and a short text unchanged", () => {
    expect(cutAtCodePoint("", 5)).toBe("");
    expect(cutAtCodePoint("ab", 5)).toBe("ab");
  });

  it("should keep a text exactly at the limit untouched, emoji included", () => {
    expect(cutAtCodePoint("ab😀", 4)).toBe("ab😀");
  });

  it("should cut exactly before, between and after a surrogate pair", () => {
    // 😀 sits at index 2-3: the only forbidden cut is between its halves.
    const text = "ab😀cd";
    expect(cutAtCodePoint(text, 2)).toBe("ab");
    expect(cutAtCodePoint(text, 3)).toBe("ab");
    expect(cutAtCodePoint(text, 4)).toBe("ab😀");
    expect(cutAtCodePoint(text, 5)).toBe("ab😀c");
  });

  it("should never split a surrogate pair inside a ZWJ emoji sequence", () => {
    // 👨‍👩‍👧‍👦 = 11 code units: 4 emoji joined by 3 ZWJ. Splitting the grapheme cluster
    // itself is acceptable — only a cut *inside* one surrogate pair is a defect.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    for (let max = 1; max < family.length; max += 1) {
      const cut = cutAtCodePoint(family, max);
      expect(family.startsWith(cut)).toBe(true);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(cut).not.toMatch(LONE_LEAD);
      expect(cut).not.toMatch(LONE_TAIL);
    }
  });

  it("should leave a lone surrogate that already exists in the input untouched", () => {
    // The cut must not *create* a lone surrogate, but it does not "repair" malformed input either.
    expect(cutAtCodePoint("ab\uD800cd", 3)).toBe("ab\uD800");
    expect(cutAtCodePoint("ab\uDC00cd", 3)).toBe("ab\uDC00");
    // A high surrogate followed by another high surrogate is not a pair: the first stays.
    expect(cutAtCodePoint("ab\uD800\uD800cd", 3)).toBe("ab\uD800");
  });

  it("should clamp zero, negative, fractional and NaN limits", () => {
    expect(cutAtCodePoint("abc", 0)).toBe("");
    expect(cutAtCodePoint("abc", -5)).toBe("");
    expect(cutAtCodePoint("abc", -2.5)).toBe("");
    expect(cutAtCodePoint("abc", Number.NaN)).toBe("");
    // A fractional limit is floored: at most `maxUnits` code units, never more.
    expect(cutAtCodePoint("abc", 2.9)).toBe("ab");
  });

  it("should treat infinities as unbounded or empty", () => {
    expect(cutAtCodePoint("abc", Number.POSITIVE_INFINITY)).toBe("abc");
    expect(cutAtCodePoint("abc", Number.NEGATIVE_INFINITY)).toBe("");
  });
});

describe("cutAtCodePoint · property contract", () => {
  // `unit: "binary"` reaches any code point — but astral chars then arrive as proper pairs and
  // lone surrogates never occur; the raw-u16 generator covers exactly that missing shape.
  const rawUnits = fc
    .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 120 })
    .map((units) => String.fromCharCode(...units));
  const textArb = fc.oneof(fc.string({ unit: "binary", maxLength: 120 }), rawUnits);
  const maxArb = fc.integer({ min: -20, max: 160 });

  it("should always return a prefix within the limit, losing at most one unit to a split pair", () => {
    fc.assert(
      fc.property(textArb, maxArb, (text, maxUnits) => {
        const cut = cutAtCodePoint(text, maxUnits);
        const max = Math.max(0, maxUnits);
        expect(text.startsWith(cut)).toBe(true);
        expect(cut.length).toBeLessThanOrEqual(max);
        if (text.length >= max) expect(cut.length).toBeGreaterThanOrEqual(max - 1);
      }),
      { numRuns: 500, seed: 20261127 },
    );
  });

  it("should never end in a high surrogate the input did not already leave lone at that spot", () => {
    fc.assert(
      fc.property(textArb, maxArb, (text, maxUnits) => {
        const cut = cutAtCodePoint(text, maxUnits);
        if (cut.length === 0) return;
        const last = cut.charCodeAt(cut.length - 1);
        if (last < 0xd800 || last > 0xdbff) return;
        // A high surrogate as the last kept unit is legal only when the very next input unit
        // is not the matching low half — i.e. it was lone in the input, not split by the cut.
        const next = text.charCodeAt(cut.length);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(false);
      }),
      { numRuns: 500, seed: 20261128 },
    );
  });

  it("should be idempotent", () => {
    fc.assert(
      fc.property(textArb, maxArb, (text, maxUnits) => {
        const cut = cutAtCodePoint(text, maxUnits);
        expect(cutAtCodePoint(cut, maxUnits)).toBe(cut);
      }),
      { numRuns: 500, seed: 20261129 },
    );
  });
});
