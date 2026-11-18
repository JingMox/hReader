// 这层管：`bookmarkCountOf` 的口径（产物真值 / `/Count` 交叉核对 / 断链报错）；手写字节，不跑 Chrome。
//
// 与 `helpers/pdf-scan.ts` 的关系是**两份独立实现**：这里刻意不复用扫描器的解析代码，
// 否则"src 读错"与"oracle 读错"会一起错、一起绿。
import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { bookmarkCountOf } from "../src/pdf/bookmarks";
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
const countOf = (outline: string): number =>
  bookmarkCountOf(bytesOf(withOutlinesOf(pagesOf(3)) + outline));

const failureOf = (bytes: Uint8Array): HrError => {
  try {
    bookmarkCountOf(bytes);
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("预期抛出 HrError");
};

const expectParseFailureOf = (bytes: Uint8Array, pattern: RegExp): void => {
  const error = failureOf(bytes);
  expect(error.code).toBe("render_empty");
  expect(error.message).toMatch(pattern);
};

describe("bookmarkCountOf · 正常路径", () => {
  it("Catalog 没有 /Outlines 键时是 0（没开大纲，不是错误）", () => {
    expect(bookmarkCountOf(bytesOf(pagesOf(2)))).toBe(0);
  });

  it("单条目：根 → `/First` → 1 条", () => {
    expect(countOf(SINGLE)).toBe(1);
  });

  it("三层嵌套：`/First` 进子层、`/Next` 走兄弟，共 4 条", () => {
    expect(countOf(NESTED)).toBe(4);
  });

  it("链尾没有 `/Next` 不算断链：两条同级就是 2", () => {
    expect(countOf(OUTLINE_TWO_SIBLINGS)).toBe(2);
  });

  it("根不带 `/Count` 时报实走数（不拿缺省的 0 顶替）", () => {
    expect(countOf(OUTLINE_NO_COUNT)).toBe(1);
  });

  it("根的 `/Count` 为负（折叠态）时按绝对值核对：仍是实走数", () => {
    expect(countOf(OUTLINE_FOLDED_COUNT)).toBe(1);
  });

  it("`/Info` 字典里的 `/Title` 不算书签（证明是从 `/Outlines` 根进树，不是数 `/Title`）", () => {
    expect(bookmarkCountOf(bytesWithInfoOf(withOutlinesOf(pagesOf(3)) + SINGLE))).toBe(1);
  });
});

describe("bookmarkCountOf · 标题里的 PDF 结构不被误当结构", () => {
  it("标题里写着 `endobj`、`/First 99 0 R`、`/Next 77 0 R`、`\\)`、嵌套 `(`、`%`：仍是 3 条", () => {
    expect(countOf(OUTLINE_HOSTILE_TITLES)).toBe(3);
  });

  it("嵌套与同级混合且 `/Count` 正确：5 条（不只摊一层、不只走兄弟）", () => {
    expect(countOf(OUTLINE_MIXED_NESTED_AND_SIBLINGS)).toBe(5);
  });

  it("真 trailer 后面的 `% trailer << /Root 99 0 R >>` 注释不算 trailer", () => {
    expect(bookmarkCountOf(bytesWithTrailerCommentOf(withOutlinesOf(pagesOf(3)) + SINGLE))).toBe(1);
  });

  it("对象的 generation 不是 0（`1 5 obj` 配 `1 5 R`）：按对象号定位，照样数得出", () => {
    expect(bookmarkCountOf(bytesWithGenerationOf(withOutlinesOf(pagesOf(3)) + SINGLE))).toBe(1);
  });
});

describe("bookmarkCountOf · 产物自相矛盾与断链", () => {
  it("/Count 自报 3、实走 2：render_empty，且 message 同时给出两个数", () => {
    expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_COUNT_LIE),
      /\/Count 自报 3 条，实走 2 条/u,
    );
  });

  it("/First 断链（指向不存在的对象）：render_empty，不回退 0", () => {
    expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_BROKEN_FIRST),
      /找不到 大纲条目 对象 99/u,
    );
  });

  it("/First 指向的对象不是字典：render_empty", () => {
    expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_NOT_A_DICTIONARY),
      /大纲条目 对象 99 不是字典/u,
    );
  });

  it("条目体带 `/Type /Page`（走错进页树）：render_empty，不等 `/Count` 兜底", () => {
    expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_PAGE_NODE),
      /大纲条目 11 是页树节点/u,
    );
  });

  it("条目成环：render_empty，不停在死循环里", () => {
    expectParseFailureOf(
      bytesOf(withOutlinesOf(pagesOf(3)) + OUTLINE_SELF_LOOP),
      /条目 11 被重复引用/u,
    );
  });
});

describe("bookmarkCountOf · 从 trailer 进树", () => {
  it("找不到 trailer：render_empty", () => {
    expectParseFailureOf(
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1"),
      /找不到 trailer/u,
    );
  });

  it("trailer 里没有 /Root：render_empty", () => {
    expectParseFailureOf(
      Buffer.from(
        "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
          "trailer\n<< /Size 99 >>\nstartxref\n0000\n%%EOF\n",
        "latin1",
      ),
      /trailer 里没有 \/Root/u,
    );
  });

  it("Catalog 的 /Outlines 指向不存在的对象：render_empty", () => {
    const catalog = withOutlinesOf(pagesOf(1)).replace("/Outlines 10 0 R", "/Outlines 98 0 R");
    expectParseFailureOf(bytesOf(catalog), /找不到 \/Outlines 对象 98/u);
  });

  it("startxref 之后再写一个非注释 trailer：仍取它之前那个真 trailer", () => {
    const bytes = bytesWithTrailingTrailerOf(withOutlinesOf(pagesOf(3)) + SINGLE);
    expect(bookmarkCountOf(bytes)).toBe(1);
  });
});

/**
 * 合法文档后面接一段坏字节/怪结构：只考扫描器容错，结论仍是 1 条。对象号取 900，免得盖掉骨架里
 * 已有对象——后写的定义会覆盖先前的，盖掉 Catalog 就会把结论变成 0，测的就不是容错了。
 * 尾巴必须插在 trailer **之前**：`bytesOf` 才会把 trailer 补到最末。
 */
const countWithTailOf = (tail: string): number =>
  bookmarkCountOf(
    Buffer.from(`${withOutlinesOf(pagesOf(1))}${SINGLE}${tail}\n${trailerOf()}`, "latin1"),
  );

const TAILS: readonly (readonly [string, string])[] = [
  ["注释没有行尾换行", "\n% 没有换行的注释"],
  ["字典里混进裸字与控制字节", "\n900 0 obj\n<< /A \u0001 1 /B junk >>\nendobj"],
  ["数组里混进裸字", "\n900 0 obj\n[ /A junk ]"],
  ["顶层孤立控制字节", "\n\u0001\n"],
  ["顶层名字值（非整数不算对象号）", "\n/Foo\n"],
  ["连着三个以上整数（只留最近两个当对象号）", "\n1 2 3 4 5\n"],
  ["流内容里含 `endobj`", "\n900 0 obj\n<< /Length 9 >>\nstream\nx endobj y\nendstream\nendobj\n"],
  ["流内容重生 Catalog、大纲指向不存在的对象", `\n${OUTLINE_STREAM_TRAP}`],
];

describe("bookmarkCountOf · 扫描器容错（坏字节不改变结论）", () => {
  for (const [name, tail] of TAILS) {
    it(`${name}：仍是 1 条`, () => {
      expect(countWithTailOf(tail)).toBe(1);
    });
  }
});

/**
 * 结构没写完（缺 `>` / 缺 `]` / 缺值）会一路吞到文件尾，连 trailer 都读不成：
 * 这时必须报错，而不是"当作这份文档没有大纲"退成 0。
 */
const UNFINISHED_TAILS: readonly (readonly [string, string])[] = [
  ["十六进制串没写收尾的 `>`", "\n900 0 obj\n<< /Pad <0a0b"],
  ["数组没写收尾的 `]`", "\n900 0 obj\n[ /A"],
  ["字典最后一个键没有值", "\n900 0 obj\n<< /A "],
];

describe("bookmarkCountOf · 结构没写完：报错而不是猜", () => {
  for (const [name, tail] of UNFINISHED_TAILS) {
    it(`${name}：render_empty，不回退 0`, () => {
      const error = ((): HrError => {
        try {
          countWithTailOf(tail);
        } catch (thrown: unknown) {
          if (thrown instanceof HrError) return thrown;
          throw thrown;
        }
        throw new Error("预期抛出 HrError");
      })();
      expect(error.code).toBe("render_empty");
    });
  }

  /**
   * 读到文件尾的几种收尾（注释、十六进制串、缺值、`stream` 没等到 `endstream`）：游标不许越界，
   * 结论是"读不出来"（这里因为没有 trailer 而报找不到 trailer），不是崩溃、也不是 0。
   */
  const AT_EOF_BODIES: readonly (readonly [string, string])[] = [
    ["注释一直写到文件尾", "%PDF-1.4\n% 一直到文件尾没有换行"],
    ["十六进制串一直写到文件尾", "%PDF-1.4\n1 0 obj\n<< /X <0a0b"],
    ["字典停在键上", "%PDF-1.4\n1 0 obj\n<< /A "],
    ["`stream` 之后没有 `endstream`", "%PDF-1.4\n1 0 obj\n<< /Length 3 >>\nstream\nabc"],
  ];

  describe("bookmarkCountOf · 读到文件尾：不越界、报读不出来", () => {
    for (const [name, body] of AT_EOF_BODIES) {
      it(`${name}：render_empty`, () => {
        expectParseFailureOf(Buffer.from(body, "latin1"), /找不到 trailer/u);
      });
    }
  });
});

describe("bookmarkCountOf · 深嵌套不借递归掌权", () => {
  it("三万层 `[` 的畸形字节：render_empty，而不是 RangeError", () => {
    expectParseFailureOf(
      Buffer.from("%PDF-1.4\n1 0 obj\n" + "[".repeat(30000), "latin1"),
      /PDF 结构解析不出：嵌套超过 40 层/u,
    );
  });
});
