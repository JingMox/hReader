// This layer covers `pdf-scan`'s own cases (page order + outline tree + text-string decoding); handwritten minimal PDFs, no Chrome.
//
// Each fixture pins one thing: single entry (object number fixes the page), three-level nesting
// (`/First`/`/Next`/`/Parent` as a tree), no `/Outlines` (a heading-less document), a **four-level page tree**, and **`/Kids` vs object numbers reversed** (the page-order rule).
import { describe, expect, it } from "vitest";

import {
  bytesOf,
  CHAIN_PAGES,
  NESTED,
  pagesOf,
  REVERSED_KIDS,
  SINGLE,
  withOutlinesOf,
} from "./helpers/pdf-fixtures";
import { pdfScanOf } from "./helpers/pdf-scan";

const scanOf = (count: number, outline: string): ReturnType<typeof pdfScanOf> =>
  pdfScanOf(bytesOf(withOutlinesOf(pagesOf(count)) + outline));

describe("pdfScanOf · single entry", () => {
  it("should set page order to /Kids array order", () => {
    expect(pdfScanOf(bytesOf(pagesOf(2))).pages).toEqual([3, 4]);
  });

  it("should return one outline entry: title verbatim, page order resolved to page 2, no children", () => {
    expect(scanOf(2, SINGLE).outline).toEqual([{ title: "Chapter One", page: 2, children: [] }]);
  });

  it("should only honor the /First chain on the tree: the outline root's type name is `/Type /Outlines` while entries have no /Type", () => {
    const root = /10 0 obj\n<<([\s\S]*?)>>/u.exec(SINGLE)?.[1] ?? "";
    expect(root).toContain("/Type /Outlines");
    expect(SINGLE.split("11 0 obj")[1]).not.toContain("/Type");
    expect(scanOf(2, SINGLE).outline).toHaveLength(1);
  });
});

describe("pdfScanOf · three-level nesting", () => {
  it("should rebuild the three-level tree along /First and /Next with page order resolved via /Dest", () => {
    expect(scanOf(3, NESTED).outline).toEqual([
      {
        title: "Part",
        page: 1,
        children: [
          { title: "Section A", page: 2, children: [{ title: "Sub A1", page: 3, children: [] }] },
          { title: "第二层", page: 3, children: [] },
        ],
      },
    ]);
  });

  it("should chain siblings via /Next, not by object-number order", () => {
    const top = scanOf(3, NESTED).outline?.[0];
    expect(top?.children.map((node) => node.title)).toEqual(["Section A", "第二层"]);
  });

  it("should error when /Parent points wrong (proves it really reads that field)", () => {
    const broken = NESTED.replace(
      "/Title (Sub A1) /Parent 12 0 R",
      "/Title (Sub A1) /Parent 11 0 R",
    );
    expect(() => scanOf(3, broken)).toThrow(/\/Parent 不是 12 0 R/u);
  });
});

describe("pdfScanOf · destinations that break shape error out (A10)", () => {
  const scanWithOf = (item: string): ReturnType<typeof pdfScanOf> =>
    pdfScanOf(
      bytesOf(
        withOutlinesOf(pagesOf(2)) +
          "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
          `11 0 obj\n<< ${item} /Parent 10 0 R >>\nendobj\n`,
      ),
    );

  it("should throw directly when /Dest's first element is not a page object reference, no guessing", () => {
    expect(() => scanWithOf("/Title (x) /Dest [1 0 R /XYZ 0 0 0]")).toThrow(
      /\/Dest 指向的 1 0 R 不在 \/Kids 页序里/u,
    );
    expect(() => scanWithOf("/Title (x) /Dest [null /XYZ 0 0 0]")).toThrow(
      /\/Dest 首元素不是页对象引用/u,
    );
  });

  it("should throw directly with neither /Dest nor /A << /D [...] >>", () => {
    expect(() => scanWithOf("/Title (x)")).toThrow(/没有 \/Dest/u);
  });
});

describe("pdfScanOf · no /Outlines", () => {
  it("should return outline as undefined (not an empty array) when the Catalog has no /Outlines key", () => {
    const scan = pdfScanOf(bytesOf(pagesOf(1)));
    expect(scan.pages).toEqual([3]);
    expect(scan.outline).toBeUndefined();
    expect(scan.outlineCount).toBeUndefined();
  });
});

describe("pdfScanOf · /Count reporting (for the e2e three-way check)", () => {
  it("should report the root's self-reported /Count verbatim (may be negative, no absolute value)", () => {
    expect(scanOf(2, SINGLE).outlineCount).toBe(1);
    expect(scanOf(3, NESTED).outlineCount).toBe(4);
    const folded = SINGLE.replace("/Count 1", "/Count -1");
    expect(scanOf(2, folded).outlineCount).toBe(-1);
  });

  it("should return undefined when the root has no /Count (reported apart from the walked count so the two can be reconciled)", () => {
    const naked = SINGLE.replace(" /Count 1", "");
    const scan = scanOf(2, naked);
    expect(scan.outlineCount).toBeUndefined();
    expect(scan.outline).toHaveLength(1);
  });
});

describe("pdfScanOf · text strings and destination decoding", () => {
  const scanWithOf = (item: string): ReturnType<typeof pdfScanOf> =>
    pdfScanOf(
      bytesOf(
        withOutlinesOf(pagesOf(2)) +
          "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
          `11 0 obj\n<< ${item} /Parent 10 0 R >>\nendobj\n`,
      ),
    );

  it("should restore escapes and octal in literal strings per PDF rules", () => {
    expect(scanWithOf("/Title (a\\(b\\)c\\\\d) /Dest [3 0 R /XYZ 0 0 0]").outline?.[0]?.title).toBe(
      "a(b)c\\d",
    );
    expect(scanWithOf("/Title (\\101\\102) /Dest [3 0 R /XYZ 0 0 0]").outline?.[0]?.title).toBe(
      "AB",
    );
  });

  it("should decode `<FEFF…>` as UTF-16BE (CJK and full-width)", () => {
    expect(
      scanWithOf("/Title <FEFF7B2C4E007AE00020FF08FF09> /Dest [3 0 R /XYZ 0 0 0]").outline?.[0]
        ?.title,
    ).toBe("第一章 （）");
  });

  it("should resolve page order for a destination in /A << /D [...] >> form", () => {
    expect(
      scanWithOf("/Title (x) /A << /S /GoTo /D [4 0 R /XYZ 0 0 0] >>").outline?.[0]?.page,
    ).toBe(2);
  });
});

describe("pdfScanOf · page order only honors /Kids order", () => {
  it("should flatten a four-level page tree recursively without intermediate `/Pages` entering page order (both one-level flattening and appending intermediate nodes are wrong)", () => {
    const scan = pdfScanOf(bytesOf(CHAIN_PAGES));
    expect(scan.pages).toEqual([4, 5]);
    expect(scan.pages).not.toContain(3);
    expect(scan.pages).not.toContain(6);
  });

  it("should follow /Kids array order when /Kids and object numbers disagree, not sort by object number", () => {
    expect(pdfScanOf(bytesOf(REVERSED_KIDS)).pages).toEqual([7, 5]);
  });

  it("should treat page order as the /Dest lookup table: an entry pointing to object 5 lands on page 2", () => {
    const reversed =
      "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
      "11 0 obj\n<< /Title (Last) /Parent 10 0 R /Dest [5 0 R /XYZ 0 800 0] >>\nendobj\n";
    const scan = pdfScanOf(bytesOf(withOutlinesOf(REVERSED_KIDS) + reversed));
    expect(scan.outline).toEqual([{ title: "Last", page: 2, children: [] }]);
  });
});
