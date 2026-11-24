// 「id 归产品所有」：`patch --action replace` 的新根**继承目标自己的 id**。
// 这层管：改完内容后老 id 仍可 read、连续 replace 同一个 id 都成立、片段自带的 id 一律不采用。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked, idOfTag, seed } from "./cli-support";
import { fieldOf, listOf, parseJsonLine, runCli, withTempDir } from "./harness";

/** 不带 id 的裸文档：先 normalize 一次拿到正文段的 id，用例里不硬编码（id 是内容派生的）。 */
const BARE_DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  "<article><h2>标题</h2><p>正文</p></article>",
  "</body></html>",
].join("\n");

const normalizedPhrasedId = async (dir: string): Promise<string> => {
  const file = seed(dir, "a.html", BARE_DOC);
  checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
  return idOfTag(readFileSync(file, "utf8"), "p");
};

const replaceOn = async (dir: string, id: string, html: string): Promise<string> => {
  const result = checked(
    await runCli(["patch", "a.html", id, "--action", "replace", "--html", html, "--json"], {
      cwd: dir,
    }),
  );
  expect(result.code).toBe(0);
  return result.stdout;
};

const dataOf = (stdout: string): unknown => fieldOf(parseJsonLine(stdout), "data");

/** 按 id 读回正文：老 id 还能命中，是“id 归产品所有”的用户可见判据。 */
const readTextOf = async (dir: string, id: string): Promise<string> => {
  const read = checked(await runCli(["read", "a.html", id], { cwd: dir }));
  expect(read.code).toBe(0);
  return read.stdout;
};

describe("patch replace · id 继承", () => {
  it("should keep the target's id so `read <old id>` still hits the new content", async () => {
    await withTempDir(async (dir) => {
      const id = await normalizedPhrasedId(dir);
      const patched = checked(
        await runCli(
          ["patch", "a.html", id, "--action", "replace", "--html", "<p>换过的正文</p>"],
          {
            cwd: dir,
          },
        ),
      );

      expect(patched.code).toBe(0);
      // id 不变 ⇒ 没有「旧 → 新」可印（humanPatch 的 id 变更分支不该出现），也没有新分配的 id。
      expect(patched.stdout).toMatch(/^patched a\.html \(\d+ bytes, \+0\)\n$/u);
      expect(patched.stdout).not.toContain("id 变更");
      expect(await readTextOf(dir, id)).toContain(`data-hr-id="${id}"`);
    });
  });

  it("should let two consecutive replaces on the same id both succeed", async () => {
    await withTempDir(async (dir) => {
      const id = await normalizedPhrasedId(dir);
      await replaceOn(dir, id, "<p>第一版</p>");
      const data = dataOf(await replaceOn(dir, id, "<p>第二版</p>"));

      expect(fieldOf(data, "newIds")).toEqual([]);
      // 空数组在 `--json` 里省略（回执不印空列表）；listOf 只把“没有”归一成空，非空仍会露出来。
      expect(listOf(fieldOf(data, "replacedIds"))).toEqual([]);

      const text = await readTextOf(dir, id);
      expect(text).toContain("第二版");
      expect(text).not.toContain("第一版");
    });
  });
});

describe("patch replace · 片段自带的 id 不采用", () => {
  it("should ignore the fragment's own data-hr-id and warn about it", async () => {
    await withTempDir(async (dir) => {
      const id = await normalizedPhrasedId(dir);
      const data = dataOf(await replaceOn(dir, id, '<p data-hr-id="hr-deadbeef">片段自带 id</p>'));

      // 片段里的 id 一个字节都不许落盘：id 由 hreader 生成。
      expect(readFileSync(`${dir}/a.html`, "utf8")).not.toContain("hr-deadbeef");
      const warnings = listOf(fieldOf(data, "warnings"));
      expect(warnings.map((item) => fieldOf(item, "code"))).toEqual(["fragment_ids_ignored"]);
      expect(String(fieldOf(warnings[0], "message"))).toContain('data-hr-id="hr-deadbeef"');
    });
  });
});
