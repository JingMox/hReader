// `snippetOf` is pure: the window math — surrogate-safe boundaries, the empty-terms and
// moved-text fallbacks — is exercised directly here (the searchLibrary tests cover the
// whole-happy-path integration).

import { describe, expect, it } from "vitest";

import { snippetOf } from "../../src/search/snippet";

const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);

describe("snippetOf", () => {
  it("returns a bare prefix with no highlights when no terms matched", () => {
    const source = "x".repeat(400);
    const snippet = snippetOf(source, []);
    expect(snippet.text).toBe("x".repeat(200));
    expect(snippet.highlights).toEqual([]);
  });

  it("returns a bare prefix when the matched term no longer sits in the text", () => {
    // The file moved between index update and snippet build: offsets must not point at
    // unrelated text — empty highlights, plain prefix.
    const snippet = snippetOf("完全无关的正文", ["目标词"]);
    expect(snippet.text).toBe("完全无关的正文");
    expect(snippet.highlights).toEqual([]);
  });

  it("never opens the window between a surrogate pair", () => {
    // 30 emoji = 60 code units; the match starts at 61, so `first.start - 48` = 13 lands
    // inside the pair [12,14): the window must step back to 12.
    const source = `${"😀".repeat(30)} 目标词 ${"y".repeat(300)}`;
    const snippet = snippetOf(source, ["目标"]);
    expect(snippet.text.includes("目标")).toBe(true);
    expect(snippet.highlights).toEqual([[49, 51]]);
    expect(snippet.text.slice(49, 51)).toBe("目标");
  });

  it("highlights every occurrence of the matched terms inside the window", () => {
    const snippet = snippetOf("开头 摩托 中段 摩托 结尾", ["摩托"]);
    expect(snippet.highlights).toEqual([
      [3, 5],
      [9, 11],
    ]);
  });

  it("opens the window exactly SNIPPET_LEAD units before the match", () => {
    // "needle" starts at 61 → from = 13: stepping one unit either way shifts the offsets.
    const snippet = snippetOf(`${"x".repeat(60)} needle ${"y".repeat(300)}`, ["needle"]);
    expect(snippet.highlights).toEqual([[48, 54]]);
    expect(snippet.text.slice(48, 54)).toBe("needle");
  });

  it("clips tokens at the window edges: start >= from, end <= end", () => {
    // "pin" starts exactly at from (0); "needle" ends exactly at the window tail (200);
    // "tailx" starts past the tail — only the first two may highlight.
    const source = `pin ${"x".repeat(189)} needle tailx ${"z".repeat(20)}`;
    const snippet = snippetOf(source, ["pin", "needle", "tailx"]);
    expect(snippet.text).toHaveLength(200);
    expect(snippet.highlights).toEqual([
      [0, 3],
      [194, 200],
    ]);
  });

  // A pair at [48, 50) with the match at 97 makes `from` = 49 — inside the pair. The lead of
  // "𐀀" is exactly 0xD800 and its trail exactly 0xDC00: both inclusive bounds are exercised.
  it("steps back onto a pair whose lead is 0xD800 and trail 0xDC00", () => {
    const source = `${"a".repeat(48)}𐀀${"b".repeat(46)} needle ${"c".repeat(300)}`;
    const snippet = snippetOf(source, ["needle"]);
    expect(snippet.text.startsWith("𐀀")).toBe(true);
    expect(snippet.highlights).toEqual([[49, 55]]);
  });

  // "\u{10ffff}" is the top of the range: lead 0xDBFF, trail 0xDFFF — the upper bounds.
  it("steps back onto a pair whose lead is 0xDBFF and trail 0xDFFF", () => {
    const source = `${"a".repeat(48)}\u{10ffff}${"b".repeat(46)} needle ${"c".repeat(300)}`;
    const snippet = snippetOf(source, ["needle"]);
    expect(snippet.text.startsWith("\u{10ffff}")).toBe(true);
    expect(snippet.highlights).toEqual([[49, 55]]);
  });

  it("does not step back between two low surrogates", () => {
    // char(48) and char(49) are both trails: a trail is not a lead, so `from` = 49 stays.
    const source = `${"a".repeat(48)}${LOW}${LOW}${"b".repeat(46)} needle ${"c".repeat(300)}`;
    const snippet = snippetOf(source, ["needle"]);
    expect(snippet.text.charCodeAt(0)).toBe(0xdc00);
    expect(snippet.highlights).toEqual([[48, 54]]);
  });

  it("does not step back between a lead surrogate and an ordinary unit", () => {
    // char(48) is a lead, char(49) is "x" (not a trail): no pair → no step.
    const source = `${"a".repeat(48)}${HIGH}x${"b".repeat(46)} needle ${"c".repeat(300)}`;
    const snippet = snippetOf(source, ["needle"]);
    expect(snippet.text.charCodeAt(0)).toBe(0x78);
    expect(snippet.highlights).toEqual([[48, 54]]);
  });

  it("does not step back between a lead surrogate and a BMP unit above the trail range", () => {
    // char(49) = 0xE000 is above 0xDFFF: isLow's upper bound is the contract.
    const source = `${"a".repeat(48)}${HIGH}${String.fromCharCode(0xe000)}${"b".repeat(46)} needle ${"c".repeat(300)}`;
    const snippet = snippetOf(source, ["needle"]);
    expect(snippet.text.charCodeAt(0)).toBe(0xe000);
    expect(snippet.highlights).toEqual([[48, 54]]);
  });
});
