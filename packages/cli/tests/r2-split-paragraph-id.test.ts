// R2-06a（docs/05:60）：一段 `<p>` 被块级元素拆成两段之后，"原来那个元素"是**首段**——
// 首段留原 `data-hr-id`、后续段没有 id（由注入阶段新分配）。这层在**落盘文本 + CLI 行为**上钉：
// 拆开的两段各占自己的区间与 id，因此 `hr patch <首段 id> --action delete` 只删那一段，
// 挪出去的表格与第二段都在；再 normalize 一次必须 `unchanged`。
//
// 解析产树那一半（第二个分段本来**不带** id）在 `packages/core/tests/html-split-paragraph-ids.test.ts`。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked, seed } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

const HR_ID_SHAPE = /^hr-[0-9a-f]{8}$/u;
const FIRST_PIECE_ID = "hr-p1";

/** quirks 文档（无 doctype）：只有 `implicitClose` 会把这个 `<table>` 挪出 `<p>`。 */
const SPLIT_DOC = [
  "<html><head><title>t</title></head><body>",
  `<article data-hr-id="hr-a"><p data-hr-id="${FIRST_PIECE_ID}">甲`,
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

const normalized = async (dir: string): Promise<string> => {
  const result = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
  expect(result.code).toBe(0);
  return readFileSync(`${dir}/a.html`, "utf8");
};

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
  expect(firstId).toBe(FIRST_PIECE_ID);
  if (secondId === undefined) throw new Error("没有拆成两段 <p>");
  expect(secondId).toMatch(HR_ID_SHAPE);
  expect(secondId).not.toBe(FIRST_PIECE_ID);

  // 全文 id 与带 id 的元素一一对应、互不相同（重复 id 会让加载侧直接拒读）。
  const ids = idsIn(html);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expect.arrayContaining([FIRST_PIECE_ID, secondId]));
  return [FIRST_PIECE_ID, secondId];
};

/** `read --json` 的 `ids` 是这一段的子树：首段读不到第二段的 id，两段确实是两个节点。 */
const expectReadShape = async (dir: string, secondId: string): Promise<void> => {
  expect(await idsOfRead(dir, FIRST_PIECE_ID)).toEqual([FIRST_PIECE_ID]);
  const articleIds = await idsOfRead(dir, "hr-a");
  expect(new Set(articleIds).size).toBe(articleIds.length);
  expect(articleIds).toEqual(expect.arrayContaining([FIRST_PIECE_ID, secondId]));
};

describe("normalize · 被块级元素拆开的 <p>（R2-06a）", () => {
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
        await runCli(["patch", "a.html", FIRST_PIECE_ID, "--action", "delete"], { cwd: dir }),
      );
      expect(deleted.code).toBe(0);

      // 首段没了；挪出去的表格与第二段**都在**（它们各有自己的区间与 id）。
      const html = readFileSync(`${dir}/a.html`, "utf8");
      expect(idsIn(html)).not.toContain(FIRST_PIECE_ID);
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
