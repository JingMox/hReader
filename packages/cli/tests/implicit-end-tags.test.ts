// 这层管：normalize 对 HTML5 隐含结束标签的处理——`<p>` 里塞 `<table>`/`<div>`/`<ul>` 时块必须拆出来
// 当兄弟而不是留成子节点；首段即使被补成零长 span 的空 `<p>` 也要保住作者写的 id（整段丢弃会让
// `#p-1` 直接 `node_not_found`）；拆开后 `<p>` 仍以自己的 id 读到自己的文本、二次 normalize 是 `unchanged`。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checked, seed } from "./cli-support";
import { runCli, withTempDir, fieldOf, parseJsonLine } from "./harness";

/** 只有一个 `<article>`、里面一个裸 `<p>` + 一段内联的块：正是 R2-06a 的输入形态。 */
const nestingDoc = (inner: string): string =>
  [
    "<!doctype html>",
    "<html><head><title>t</title></head><body>",
    `<article><p>前${inner}</p></article>`,
    "</body></html>",
  ].join("\n");

const CASES: readonly {
  readonly name: string;
  readonly inner: string;
  readonly blockTag: string;
}[] = [
  { name: "<table>", inner: "<table><tr><td>1</td></tr></table>", blockTag: "table" },
  { name: "<div>", inner: "<div>b</div>", blockTag: "div" },
  { name: "<ul>", inner: "<ul><li>b</li></ul>", blockTag: "ul" },
];

/** `<p>` 里不许有 `table`/`div`/`ul`：拆对的判据就是 p 之后紧跟着同名块，且它不在 p 内。 */
const expectSplitOutOfParagraph = (html: string, blockTag: string): string => {
  const paragraph = /<p data-hr-id="([^"]+)">前<\/p>/u.exec(html);
  if (paragraph === null) throw new Error(`规范化之后没有“只含『前』的 <p>”：${html}`);
  const paragraphId = String(paragraph[1]);
  // `<p …>前</p>` 之后紧接同名块 = 它是 p 的**兄弟**（在 p 里的话根本不会出现这个片段）。
  expect(html).toContain(`</p><${blockTag} data-hr-id=`);
  expect(html).not.toMatch(new RegExp(`<p[^>]*>[^<]*<${blockTag}`, "u"));
  return paragraphId;
};

describe("normalize · 隐含结束标签", () => {
  it.each(CASES)(
    "should split $name out of the paragraph and keep the paragraph addressable",
    async ({ inner, blockTag }) => {
      await withTempDir(async (dir) => {
        seed(dir, "a.html", nestingDoc(inner));

        const written = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
        expect(written.code).toBe(0);
        const paragraphId = expectSplitOutOfParagraph(
          readFileSync(`${dir}/a.html`, "utf8"),
          blockTag,
        );

        // `<p>` 的 id 仍指它自己那段文本：拆开块不许把锚点带跑。
        const read = checked(await runCli(["read", "a.html", paragraphId], { cwd: dir }));
        expect(read.stdout).toContain("前");
        expect(read.stdout).not.toContain(blockTag);
        expect(read.stdout).toContain(`data-hr-id="${paragraphId}"`);

        // 二次 normalize 必须一字不动：拆一次就稳定，不能每跑一次都改字节。
        const again = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
        expect(again.stdout).toMatch(/^unchanged a\.html \(\d+ bytes，已带齐 data-hr-id\)\n$/u);
      });
    },
  );
});
const FIRST_PIECE_ID = "p-1";

/**
 * 无 doctype = quirks：块级 `<table>` 在 `<p>` 里，只有 `implicitClose` 会把它挪出去。
 * `<p>` 与 `<table>` 之间**不留空白**：中间只要有空白文本节点，首段就不空了，也就走不到要钉的那条分支。
 */
const EMPTY_FIRST_PIECE_DOC = [
  "<html><head><title>t</title></head><body>",
  `<article data-hr-id="hr-a"><p data-hr-id="${FIRST_PIECE_ID}"><table><tr><td>1</td></tr></table></p><p data-hr-id="p-2">后</p></article>`,
  "</body></html>",
].join("\n");

const htmlOf = (dir: string): string => readFileSync(`${dir}/a.html`, "utf8");

const normalized = async (dir: string): Promise<string> => {
  const result = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
  expect(result.code).toBe(0);
  return htmlOf(dir);
};

describe("normalize · 空首段的 id · 回读", () => {
  it("should keep the id on the empty paragraph and still read it back", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", EMPTY_FIRST_PIECE_DOC);

      const html = await normalized(dir);
      // 空首段与挪出去的表**都是**落盘产物：空 `<p>` 留着 id，表是它的兄弟。
      expect(html).toMatch(/<p data-hr-id="p-1"><\/p><table\b/u);

      const read = checked(
        await runCli(["read", "a.html", FIRST_PIECE_ID, "--json"], { cwd: dir }),
      );
      expect(read.code).toBe(0);
      const data = fieldOf(parseJsonLine(read.stdout), "data");
      expect(fieldOf(data, "html")).toBe('<p data-hr-id="p-1"></p>');
      // id 凭空消失会以 `id_reassigned` 露面；这里既没丢也没改名。
      expect(fieldOf(data, "diagnostics")).toEqual([]);
    });
  });
});

describe("normalize · 空首段的 id · 删除", () => {
  it("should delete only the empty paragraph and leave the moved table behind", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", EMPTY_FIRST_PIECE_DOC);
      await normalized(dir);

      // 零长 span 的边界：这个空段在源码里只有 `<p …></p>` 这段字节，delete 必须真的删掉它。
      const deleted = checked(
        await runCli(["patch", "a.html", FIRST_PIECE_ID, "--action", "delete"], { cwd: dir }),
      );
      expect(deleted.code).toBe(0);

      const html = htmlOf(dir);
      expect(html).not.toContain(FIRST_PIECE_ID);
      expect(html).toContain("<table");
      expect(html).toContain('data-hr-id="p-2"');
      expect(html).not.toMatch(/<p data-hr-id="p-1"/u);

      // 删完文档仍然自洽：再 normalize 一次什么都不改。
      const again = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
      expect(again.stdout).toMatch(/^unchanged a\.html \(\d+ bytes，已带齐 data-hr-id\)\n$/u);
    });
  });
});
const HR_ID_SHAPE = /^hr-[0-9a-f]{8}$/u;
const SPLIT_FIRST_ID = "hr-p1";

/** quirks 文档（无 doctype）：只有 `implicitClose` 会把这个 `<table>` 挪出 `<p>`。 */
const SPLIT_DOC = [
  "<html><head><title>t</title></head><body>",
  `<article data-hr-id="hr-a"><p data-hr-id="${SPLIT_FIRST_ID}">甲`,
  "<table><tr><td>1</td></tr></table>",
  "乙</p></article>",
  "</body></html>",
].join("\n");

/** 文件里所有 `data-hr-id` 的值（按出现序）。 */
const idsIn = (html: string): readonly string[] =>
  [...html.matchAll(/data-hr-id="([^"]*)"/gu)].map((match) => match[1] ?? "");

/** 两个 `<p …>` 的 `data-hr-id`：规范化之后恰好两段，顺序 = 文档序。 */
const paragraphIdsIn = (html: string): readonly (string | undefined)[] =>
  [...html.matchAll(/<p\b[^>]*>/gu)].map((match) => /data-hr-id="([^"]+)"/u.exec(match[0])?.[1]);

const idsOfRead = async (dir: string, target: string): Promise<readonly string[]> => {
  const result = checked(await runCli(["read", "a.html", target, "--json"], { cwd: dir }));
  expect(result.code).toBe(0);
  const ids = fieldOf(fieldOf(parseJsonLine(result.stdout), "data"), "ids");
  if (!Array.isArray(ids)) throw new Error("read --json 的 ids 不是数组");
  return ids.map((id: unknown) => String(id));
};

/** 拆开后的落盘文本：两段 `<p>` 夹着**兄弟**表格，段与块之间的空白归前一段；返回两段的 id。 */
const expectSplitShape = async (dir: string): Promise<readonly [string, string]> => {
  const html = await normalized(dir);
  expect(html).toMatch(/<p\b[^>]*>甲\s*<\/p><table\b/u);
  expect(html).toMatch(/<\/table><p\b[^>]*>\s*乙<\/p>/u);
  expect(html).not.toMatch(/<p\b[^>]*>[^<]*<table/u);

  const [firstId, secondId] = paragraphIdsIn(html);
  // 首段 = 原来那个元素：id 一字不差；第二段是**另一个**元素，有自己的新 id。
  expect(firstId).toBe(SPLIT_FIRST_ID);
  if (secondId === undefined) throw new Error("没有拆成两段 <p>");
  expect(secondId).toMatch(HR_ID_SHAPE);
  expect(secondId).not.toBe(SPLIT_FIRST_ID);

  // 全文 id 与带 id 的元素一一对应、互不相同（重复 id 会让加载侧直接拒读）。
  const ids = idsIn(html);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expect.arrayContaining([SPLIT_FIRST_ID, secondId]));
  return [SPLIT_FIRST_ID, secondId];
};

/** `read --json` 的 `ids` 是这一段的子树：首段读不到第二段的 id，两段确实是两个节点。 */
const expectReadShape = async (dir: string, secondId: string): Promise<void> => {
  expect(await idsOfRead(dir, SPLIT_FIRST_ID)).toEqual([SPLIT_FIRST_ID]);
  const articleIds = await idsOfRead(dir, "hr-a");
  expect(new Set(articleIds).size).toBe(articleIds.length);
  expect(articleIds).toEqual(expect.arrayContaining([SPLIT_FIRST_ID, secondId]));
};

describe("normalize · 被块级元素拆开的 <p>", () => {
  it("should keep the original id on the first piece and give the second piece its own id", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", SPLIT_DOC);

      const [, secondId] = await expectSplitShape(dir);
      await expectReadShape(dir, secondId);
    });
  });

  it("should delete only the first piece and leave the moved table and the second piece", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", SPLIT_DOC);
      const [, secondId] = await expectSplitShape(dir);

      const deleted = checked(
        await runCli(["patch", "a.html", SPLIT_FIRST_ID, "--action", "delete"], { cwd: dir }),
      );
      expect(deleted.code).toBe(0);

      // 首段没了；挪出去的表格与第二段**都在**（它们各有自己的区间与 id）。
      const html = readFileSync(`${dir}/a.html`, "utf8");
      expect(idsIn(html)).not.toContain(SPLIT_FIRST_ID);
      expect(html).not.toContain("甲");
      expect(html).toContain("<table");
      expect(html).toContain("乙");
      expect(idsIn(html)).toContain(secondId);

      // 删首段之后文档仍然自洽：再 normalize 一次什么都不改。
      const again = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
      expect(again.stdout).toMatch(/^unchanged a\.html \(\d+ bytes，已带齐 data-hr-id\)\n$/u);
      expect(idsIn(readFileSync(`${dir}/a.html`, "utf8"))).toContain(secondId);
    });
  });
});
