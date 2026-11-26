// This layer covers `inspectPdfOf` rules (artifact truth / `/Count` cross-check / broken-chain errors); handwritten bytes, no Chrome.
//
// Its relation to `helpers/pdf-scan.ts` is **two independent implementations**: this one parses strictly via
// pdf-lib, the oracle is its own byte-level scanner; "src misreads" and "oracle misreads" can never be green together.
import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { inspectPdfOf } from "../src/pdf/report";
import {
  bytesOf,
  bytesWithGenerationOf,
  bytesWithInfoOf,
  bytesWithTrailerCommentOf,
  bytesWithTrailingTrailerOf,
  NESTED,
  OUTLINE_BROKEN_FIRST,
  OUTLINE_COUNT_LIE,
  OUTLINE_FOLDED_COUNT,
  OUTLINE_HOSTILE_TITLES,
  OUTLINE_MIXED_NESTED_AND_SIBLINGS,
  OUTLINE_NOT_A_DICTIONARY,
  OUTLINE_NO_COUNT,
  OUTLINE_PAGE_NODE,
  OUTLINE_SELF_LOOP,
  OUTLINE_STREAM_TRAP,
  OUTLINE_TWO_SIBLINGS,
  pagesOf,
  SINGLE,
  trailerOf,
  withOutlinesOf,
} from "./helpers/pdf-fixtures";

/** Three-page skeleton + `/Outlines 10 0 R` + an outline body: the count rule is unrelated to page count, but a fixed page count keeps broken chains visible. */
const outlineOf = (outline: string): Promise<number> =>
  inspectPdfOf(bytesOf(withOutlinesOf(pagesOf(3)) + outline)).then((facts) => facts.outline);

const failureOf = async (bytes: Uint8Array): Promise<HrError> => {
  try {
    await inspectPdfOf(bytes);
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("expected an HrError to be thrown");
};

const expectParseFailureOf = async (bytes: Uint8Array, pattern: RegExp): Promise<void> => {
  const error = await failureOf(bytes);
  expect(error.code).toBe("render_empty");
  expect(error.message).toMatch(pattern);
};

describe("inspectPdfOf · happy path", () => {
  it("should report pages and outline together: a three-page skeleton without outline is { pages: 3, outline: 0 }", async () => {
    expect(await inspectPdfOf(bytesOf(pagesOf(3)))).toEqual({ pages: 3, outline: 0 });
  });

  it("should report 0 when the Catalog has no /Outlines key (outline off, not an error)", async () => {
    expect(await inspectPdfOf(bytesOf(pagesOf(2)))).toEqual({ pages: 2, outline: 0 });
  });

  it("should walk root → `/First` → 1 entry for a single entry", async () => {
    expect(await outlineOf(SINGLE)).toBe(1);
  });

  it("should enter children via `/First` and siblings via `/Next` for three-level nesting: 4 entries", async () => {
    expect(await outlineOf(NESTED)).toBe(4);
  });

  it("should not treat a missing `/Next` at the chain tail as broken: two siblings count as 2", async () => {
    expect(await outlineOf(OUTLINE_TWO_SIBLINGS)).toBe(2);
  });

  it("should report the walked count when the root has no `/Count` (not substitute a default 0)", async () => {
    expect(await outlineOf(OUTLINE_NO_COUNT)).toBe(1);
  });

  it("should cross-check a negative root `/Count` (collapsed) by absolute value: still the walked count", async () => {
    expect(await outlineOf(OUTLINE_FOLDED_COUNT)).toBe(1);
  });

  it("should not count an `/Info` dictionary's `/Title` as a bookmark (proves the walk enters via the `/Outlines` root, not by counting `/Title`)", async () => {
    const facts = await inspectPdfOf(bytesWithInfoOf(withOutlinesOf(pagesOf(3)) + SINGLE));
    expect(facts.outline).toBe(1);
  });
});

describe("inspectPdfOf · PDF structure inside titles is not mistaken for structure", () => {
  it("should still count 3 when titles contain `endobj`, `/First 99 0 R`, `/Next 77 0 R`, `\\)`, nested `(`, `%`", async () => {
    expect(await outlineOf(OUTLINE_HOSTILE_TITLES)).toBe(3);
  });

  it("should count 5 with nesting and siblings mixed and `/Count` correct (not one-level-flat, not siblings-only)", async () => {
    expect(await outlineOf(OUTLINE_MIXED_NESTED_AND_SIBLINGS)).toBe(5);
  });

  it("should not treat a `% trailer << /Root 99 0 R >>` comment after the real trailer as a trailer", async () => {
    const facts = await inspectPdfOf(
      bytesWithTrailerCommentOf(withOutlinesOf(pagesOf(3)) + SINGLE),
    );
    expect(facts.outline).toBe(1);
  });

  it("should still count when an object's generation is not 0 (`1 5 obj` paired with `1 5 R`): locate by object number", async () => {
    const facts = await inspectPdfOf(bytesWithGenerationOf(withOutlinesOf(pagesOf(3)) + SINGLE));
    expect(facts.outline).toBe(1);
  });

  it("should still take the real trailer when a non-comment trailer is written after startxref", async () => {
    const facts = await inspectPdfOf(
      bytesWithTrailingTrailerOf(withOutlinesOf(pagesOf(3)) + SINGLE),
    );
    expect(facts.outline).toBe(1);
  });

  it("should not treat content-stream bytes impersonating a Catalog as structure: still 1 entry via the real body", async () => {
    const facts = await inspectPdfOf(
      Buffer.from(
        `${withOutlinesOf(pagesOf(1))}${SINGLE}${OUTLINE_STREAM_TRAP}\n${trailerOf()}`,
        "latin1",
      ),
    );
    expect(facts.outline).toBe(1);
  });
});

describe("inspectPdfOf · self-contradicting artifacts and broken chains", () => {
  it("should report render_empty with both numbers in the message when /Count claims 3 but the walk finds 2", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_COUNT_LIE),
      /\/Count 自报 3 条，实走 2 条/u,
    );
  });

  it("should report render_empty for a /First broken chain (points to a nonexistent object), not fall back to 0", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_BROKEN_FIRST),
      /找不到 大纲条目 对象 99/u,
    );
  });

  it("should report render_empty when the object /First points to is not a dictionary", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_NOT_A_DICTIONARY),
      /大纲条目 对象 99 不是字典/u,
    );
  });

  it("should report render_empty when an entry body carries `/Type /Page` (walked into the page tree), not wait on the /Count net", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_PAGE_NODE),
      /大纲条目 11 是页树节点/u,
    );
  });

  it("should report render_empty on an entry cycle, not hang in a loop", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_SELF_LOOP),
      /条目 11 被重复引用/u,
    );
  });
});

describe("inspectPdfOf · tree-entry failures and bad bytes", () => {
  it("should report render_empty when the Catalog's /Outlines points to a nonexistent object", async () => {
    const body = withOutlinesOf(pagesOf(1)).replace("/Outlines 10 0 R", "/Outlines 98 0 R");
    await expectParseFailureOf(bytesOf(body + SINGLE), /找不到 \/Outlines 对象 98/u);
  });

  it("should report render_empty when the object /Outlines points to is not a dictionary", async () => {
    const body = withOutlinesOf(pagesOf(1)).replace("/Outlines 10 0 R", "/Outlines 98 0 R");
    await expectParseFailureOf(
      Buffer.from(`${body}98 0 obj\n42\nendobj\n${trailerOf()}`, "latin1"),
      /\/Outlines 对象 98 不是字典/u,
    );
  });

  it("should report render_empty for something not a PDF at all: a structure-level failure", async () => {
    await expectParseFailureOf(Buffer.from("hello world", "latin1"), /PDF 结构解析不出/u);
  });

  it("should report render_empty with no trailer: the page tree cannot even stand", async () => {
    await expectParseFailureOf(
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1"),
      /PDF 结构解析不出/u,
    );
  });

  it("should report render_empty with no /Root in the trailer", async () => {
    await expectParseFailureOf(
      Buffer.from(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
          "trailer\n<< /Size 99 >>\nstartxref\n0000\n%%EOF\n",
        "latin1",
      ),
      /PDF 结构解析不出/u,
    );
  });
});
