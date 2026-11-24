// 这层管：`inspectPdfOf` 的口径（产物真值 / `/Count` 交叉核对 / 断链报错）；手写字节，不跑 Chrome。
//
// 与 `helpers/pdf-scan.ts` 的关系是**两份独立实现**：这里走 pdf-lib 严格解析，
// oracle 那套是自己的字节级扫描器；"src 读错"与"oracle 读错"不会一起绿。
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

/** 三页骨架 + `/Outlines 10 0 R` + 大纲体：条数口径与页数无关，页数固定才看得清断链。 */
const outlineOf = (outline: string): Promise<number> =>
  inspectPdfOf(bytesOf(withOutlinesOf(pagesOf(3)) + outline)).then((facts) => facts.outline);

const failureOf = async (bytes: Uint8Array): Promise<HrError> => {
  try {
    await inspectPdfOf(bytes);
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("预期抛出 HrError");
};

const expectParseFailureOf = async (bytes: Uint8Array, pattern: RegExp): Promise<void> => {
  const error = await failureOf(bytes);
  expect(error.code).toBe("render_empty");
  expect(error.message).toMatch(pattern);
};

describe("inspectPdfOf · 正常路径", () => {
  it("页数与大纲一起报：三页骨架无大纲是 { pages: 3, outline: 0 }", async () => {
    expect(await inspectPdfOf(bytesOf(pagesOf(3)))).toEqual({ pages: 3, outline: 0 });
  });

  it("Catalog 没有 /Outlines 键时是 0（没开大纲，不是错误）", async () => {
    expect(await inspectPdfOf(bytesOf(pagesOf(2)))).toEqual({ pages: 2, outline: 0 });
  });

  it("单条目：根 → `/First` → 1 条", async () => {
    expect(await outlineOf(SINGLE)).toBe(1);
  });

  it("三层嵌套：`/First` 进子层、`/Next` 走兄弟，共 4 条", async () => {
    expect(await outlineOf(NESTED)).toBe(4);
  });

  it("链尾没有 `/Next` 不算断链：两条同级就是 2", async () => {
    expect(await outlineOf(OUTLINE_TWO_SIBLINGS)).toBe(2);
  });

  it("根不带 `/Count` 时报实走数（不拿缺省的 0 顶替）", async () => {
    expect(await outlineOf(OUTLINE_NO_COUNT)).toBe(1);
  });

  it("根的 `/Count` 为负（折叠态）时按绝对值核对：仍是实走数", async () => {
    expect(await outlineOf(OUTLINE_FOLDED_COUNT)).toBe(1);
  });

  it("`/Info` 字典里的 `/Title` 不算书签（证明是从 `/Outlines` 根进树，不是数 `/Title`）", async () => {
    const facts = await inspectPdfOf(bytesWithInfoOf(withOutlinesOf(pagesOf(3)) + SINGLE));
    expect(facts.outline).toBe(1);
  });
});

describe("inspectPdfOf · 标题里的 PDF 结构不被误当结构", () => {
  it("标题里写着 `endobj`、`/First 99 0 R`、`/Next 77 0 R`、`\\)`、嵌套 `(`、`%`：仍是 3 条", async () => {
    expect(await outlineOf(OUTLINE_HOSTILE_TITLES)).toBe(3);
  });

  it("嵌套与同级混合且 `/Count` 正确：5 条（不只摊一层、不只走兄弟）", async () => {
    expect(await outlineOf(OUTLINE_MIXED_NESTED_AND_SIBLINGS)).toBe(5);
  });

  it("真 trailer 后面的 `% trailer << /Root 99 0 R >>` 注释不算 trailer", async () => {
    const facts = await inspectPdfOf(
      bytesWithTrailerCommentOf(withOutlinesOf(pagesOf(3)) + SINGLE),
    );
    expect(facts.outline).toBe(1);
  });

  it("对象的 generation 不是 0（`1 5 obj` 配 `1 5 R`）：按对象号定位，照样数得出", async () => {
    const facts = await inspectPdfOf(bytesWithGenerationOf(withOutlinesOf(pagesOf(3)) + SINGLE));
    expect(facts.outline).toBe(1);
  });

  it("startxref 之后再写一个非注释 trailer：仍取真 trailer 那份", async () => {
    const facts = await inspectPdfOf(
      bytesWithTrailingTrailerOf(withOutlinesOf(pagesOf(3)) + SINGLE),
    );
    expect(facts.outline).toBe(1);
  });

  it("内容流里写着冒名 Catalog 的字节：流内容不算结构，仍按正文走 1 条", async () => {
    const facts = await inspectPdfOf(
      Buffer.from(
        `${withOutlinesOf(pagesOf(1))}${SINGLE}${OUTLINE_STREAM_TRAP}\n${trailerOf()}`,
        "latin1",
      ),
    );
    expect(facts.outline).toBe(1);
  });
});

describe("inspectPdfOf · 产物自相矛盾与断链", () => {
  it("/Count 自报 3、实走 2：render_empty，且 message 同时给出两个数", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_COUNT_LIE),
      /\/Count 自报 3 条，实走 2 条/u,
    );
  });

  it("/First 断链（指向不存在的对象）：render_empty，不回退 0", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_BROKEN_FIRST),
      /找不到 大纲条目 对象 99/u,
    );
  });

  it("/First 指向的对象不是字典：render_empty", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_NOT_A_DICTIONARY),
      /大纲条目 对象 99 不是字典/u,
    );
  });

  it("条目体带 `/Type /Page`（走错进页树）：render_empty，不等 `/Count` 兜底", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_PAGE_NODE),
      /大纲条目 11 是页树节点/u,
    );
  });

  it("条目成环：render_empty，不停在死循环里", async () => {
    await expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_SELF_LOOP),
      /条目 11 被重复引用/u,
    );
  });
});

describe("inspectPdfOf · 进树失败与坏字节", () => {
  it("Catalog 的 /Outlines 指向不存在的对象：render_empty", async () => {
    const body = withOutlinesOf(pagesOf(1)).replace("/Outlines 10 0 R", "/Outlines 98 0 R");
    await expectParseFailureOf(bytesOf(body + SINGLE), /找不到 \/Outlines 对象 98/u);
  });

  it("/Outlines 指向的对象不是字典：render_empty", async () => {
    const body = withOutlinesOf(pagesOf(1)).replace("/Outlines 10 0 R", "/Outlines 98 0 R");
    await expectParseFailureOf(
      Buffer.from(`${body}98 0 obj\n42\nendobj\n${trailerOf()}`, "latin1"),
      /\/Outlines 对象 98 不是字典/u,
    );
  });

  it("根本不是 PDF：render_empty，报的是结构层失败", async () => {
    await expectParseFailureOf(Buffer.from("hello world", "latin1"), /PDF 结构解析不出/u);
  });

  it("没有 trailer：页树都立不起来，render_empty", async () => {
    await expectParseFailureOf(
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1"),
      /PDF 结构解析不出/u,
    );
  });

  it("trailer 里没有 /Root：render_empty", async () => {
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
