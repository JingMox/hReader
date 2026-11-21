// F20 / BLOCKER-2（docs/05:55：「隐含结束产生的空段落同样获得 id」）：quirks 文档的
// `<p data-hr-id="p-1"><table>…</table></p>` 首段没有任何行内内容。`implicitClose` 会把首段补成
// 一个零长 span 的空 `<p>` 把作者写的 id 留住，而不是整段丢弃（丢弃会让 `#p-1` 直接 `node_not_found`）。
//
// 这层在**落盘字节与 CLI 行为**上钉：落盘后 id 还在那个 `<p>` 上、`read #p-1` 命中、
// `patch <首段 id> --action delete` 只删这个空段（零长 span 在 delete 下必须真的删得掉）。
// 解析产树那一半在 `packages/core/tests/html-implicit-close-empty.test.ts`。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked, seed } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

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

describe("normalize · 空首段的 id · 回读（F20 / BLOCKER-2）", () => {
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

describe("normalize · 空首段的 id · 删除（F20 / BLOCKER-2）", () => {
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
