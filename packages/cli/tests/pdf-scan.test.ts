// 这层管：`pdf-scan` 自己的用例（页序 + 大纲树 + 文本串解码）；手写最小 PDF，不跑 Chrome。
//
// 夹具各钉一件事：单条目（对象号定页）、三层嵌套（`/First`/`/Next`/`/Parent` 成树）、
// 无 `/Outlines`（无 heading 的文档）、**四层页树**与 **`/Kids` 与对象号逆序**（页序口径）。
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

describe("pdfScanOf · 单条目", () => {
  it("页序 = /Kids 数组顺序", () => {
    expect(pdfScanOf(bytesOf(pagesOf(2))).pages).toEqual([3, 4]);
  });

  it("一条大纲：标题原样、页序换算到第 2 页、无子项", () => {
    expect(scanOf(2, SINGLE).outline).toEqual([{ title: "Chapter One", page: 2, children: [] }]);
  });

  it("大纲根对象的类型名是 `/Type /Outlines`，条目本身没有 /Type：树上只认 /First 链", () => {
    const root = /10 0 obj\n<<([\s\S]*?)>>/u.exec(SINGLE)?.[1] ?? "";
    expect(root).toContain("/Type /Outlines");
    expect(SINGLE.split("11 0 obj")[1]).not.toContain("/Type");
    expect(scanOf(2, SINGLE).outline).toHaveLength(1);
  });
});

describe("pdfScanOf · 三层嵌套", () => {
  it("沿 /First 与 /Next 还原三层树，页序按 /Dest 换算", () => {
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

  it("兄弟靠 /Next 串起来，不靠对象号大小", () => {
    const top = scanOf(3, NESTED).outline?.[0];
    expect(top?.children.map((node) => node.title)).toEqual(["Section A", "第二层"]);
  });

  it("/Parent 指错时报错（证明它真在读这一项）", () => {
    const broken = NESTED.replace(
      "/Title (Sub A1) /Parent 12 0 R",
      "/Title (Sub A1) /Parent 11 0 R",
    );
    expect(() => scanOf(3, broken)).toThrow(/\/Parent 不是 12 0 R/u);
  });
});

describe("pdfScanOf · 目的地不合形态就报错（A10）", () => {
  const scanWithOf = (item: string): ReturnType<typeof pdfScanOf> =>
    pdfScanOf(
      bytesOf(
        withOutlinesOf(pagesOf(2)) +
          "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
          `11 0 obj\n<< ${item} /Parent 10 0 R >>\nendobj\n`,
      ),
    );

  it("/Dest 首元素不是页对象引用：直接抛，不猜", () => {
    expect(() => scanWithOf("/Title (x) /Dest [1 0 R /XYZ 0 0 0]")).toThrow(
      /\/Dest 指向的 1 0 R 不在 \/Kids 页序里/u,
    );
    expect(() => scanWithOf("/Title (x) /Dest [null /XYZ 0 0 0]")).toThrow(
      /\/Dest 首元素不是页对象引用/u,
    );
  });

  it("既没 /Dest 也没 /A << /D [...] >>：直接抛", () => {
    expect(() => scanWithOf("/Title (x)")).toThrow(/没有 \/Dest/u);
  });
});

describe("pdfScanOf · 无 /Outlines", () => {
  it("Catalog 没有 /Outlines 键时 outline 是 undefined（不是空数组）", () => {
    const scan = pdfScanOf(bytesOf(pagesOf(1)));
    expect(scan.pages).toEqual([3]);
    expect(scan.outline).toBeUndefined();
    expect(scan.outlineCount).toBeUndefined();
  });
});

describe("pdfScanOf · /Count 报告（供 e2e 三方对照）", () => {
  it("根对象自报的 /Count 原样报出（可为负，不做绝对值）", () => {
    expect(scanOf(2, SINGLE).outlineCount).toBe(1);
    expect(scanOf(3, NESTED).outlineCount).toBe(4);
    const folded = SINGLE.replace("/Count 1", "/Count -1");
    expect(scanOf(2, folded).outlineCount).toBe(-1);
  });

  it("根不带 /Count 时是 undefined（与实走数分开报，两边才能对帐）", () => {
    const naked = SINGLE.replace(" /Count 1", "");
    const scan = scanOf(2, naked);
    expect(scan.outlineCount).toBeUndefined();
    expect(scan.outline).toHaveLength(1);
  });
});

describe("pdfScanOf · 文本串与目的地解码", () => {
  const scanWithOf = (item: string): ReturnType<typeof pdfScanOf> =>
    pdfScanOf(
      bytesOf(
        withOutlinesOf(pagesOf(2)) +
          "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
          `11 0 obj\n<< ${item} /Parent 10 0 R >>\nendobj\n`,
      ),
    );

  it("字面串按 PDF 规则还原转义与八进制", () => {
    expect(scanWithOf("/Title (a\\(b\\)c\\\\d) /Dest [3 0 R /XYZ 0 0 0]").outline?.[0]?.title).toBe(
      "a(b)c\\d",
    );
    expect(scanWithOf("/Title (\\101\\102) /Dest [3 0 R /XYZ 0 0 0]").outline?.[0]?.title).toBe(
      "AB",
    );
  });

  it("`<FEFF…>` 按 UTF-16BE 解码（中文与全角）", () => {
    expect(
      scanWithOf("/Title <FEFF7B2C4E007AE00020FF08FF09> /Dest [3 0 R /XYZ 0 0 0]").outline?.[0]
        ?.title,
    ).toBe("第一章 （）");
  });

  it("/A << /D [...] >> 形式的目的地也能算页序", () => {
    expect(
      scanWithOf("/Title (x) /A << /S /GoTo /D [4 0 R /XYZ 0 0 0] >>").outline?.[0]?.page,
    ).toBe(2);
  });
});

describe("pdfScanOf · 页序只认 /Kids 顺序", () => {
  it("四层页树：递归摊平，中间 `/Pages` 不进页序（只摊一层、中间节点追加到页序末尾都是错的）", () => {
    const scan = pdfScanOf(bytesOf(CHAIN_PAGES));
    expect(scan.pages).toEqual([4, 5]);
    expect(scan.pages).not.toContain(3);
    expect(scan.pages).not.toContain(6);
  });

  it("`/Kids` 与对象号逆序时按 `/Kids` 数组顺序，不按对象号排", () => {
    expect(pdfScanOf(bytesOf(REVERSED_KIDS)).pages).toEqual([7, 5]);
  });

  it("页序就是 `/Dest` 的换算表：指向对象 5 的条目落在第 2 页", () => {
    const reversed =
      "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
      "11 0 obj\n<< /Title (Last) /Parent 10 0 R /Dest [5 0 R /XYZ 0 800 0] >>\nendobj\n";
    const scan = pdfScanOf(bytesOf(withOutlinesOf(REVERSED_KIDS) + reversed));
    expect(scan.outline).toEqual([{ title: "Last", page: 2, children: [] }]);
  });
});
