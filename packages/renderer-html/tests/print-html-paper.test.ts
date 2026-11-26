// Re-lays out the `@page` paper per input; actual Chrome pagination is not tested here — that needs real hardware.
import { describe, expect, it } from "vitest";

import { printHtmlOf } from "../src/index";
import type { PaperSize } from "../src/index";
import { fixtureOf, inputOf } from "./support";

const PAGE_SIZE = /@page \{\n {2}size: ([^;]+);/u;

const pageSizeOf = (paper: PaperSize): string => {
  const matched = PAGE_SIZE.exec(printHtmlOf(inputOf(fixtureOf("article.html"), { paper })))?.[1];
  if (matched === undefined) {
    throw new Error(`产物里没有 @page 的 size：${paper}`);
  }
  return matched;
};

describe("paper re-layout", () => {
  it("should emit three distinct @page sizes for the three paper tiers", () => {
    const sizes = (["a4", "letter", "a5"] as const).map((paper) => pageSizeOf(paper));
    expect(sizes).toEqual(["A4", "letter", "A5"]);
    expect(new Set(sizes).size).toBe(3);
  });

  it("should change only the @page size line when switching paper, leaving margins and all other bytes untouched", () => {
    const a4 = printHtmlOf(inputOf(fixtureOf("article.html"), { paper: "a4" }));
    const a5 = printHtmlOf(inputOf(fixtureOf("article.html"), { paper: "a5" }));
    const letter = printHtmlOf(inputOf(fixtureOf("article.html"), { paper: "letter" }));
    expect(a5).toBe(a4.replace("size: A4;", "size: A5;"));
    expect(letter).toBe(a4.replace("size: A4;", "size: letter;"));
  });
});
