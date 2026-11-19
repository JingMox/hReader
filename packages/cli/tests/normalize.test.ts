// 这层管：`hr normalize`（B-01/B-02/B-03 的兑现物）——先补 id 才能 outline/read/patch/serve。
//
// 用户视角的三件事，一条不能少：
//   1. 不加 `--write` 时只看不写（把结果打到 stdout，文件一个字节不动）；
//   2. `--write` 落盘，且**已有 id 一字不动**；连跑第二次 `injected=0`、字节不变（幂等）；
//   3. 没有 `<article>` 时明说"这不是可规范化的文档"（`invalid_document`，退出 1），不是空转。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, textOf, withTempDir, type CliResult } from "./harness";

/** 手写文档：封面 + 3 章 + 一节，**没有任何** `data-hr-id`（用户真实原料）。 */
export const HANDWRITTEN = [
  "<!doctype html>",
  "<html><head><title>季度复盘</title></head><body>",
  '<header class="cover"><h1>季度复盘</h1><p>封面副标题</p></header>',
  "<article>",
  "<h1>第一章 把发布节奏拉回来</h1><p>第一章正文。</p>",
  "<h2>1.1 先把回滚路径跑通</h2><p>小节正文。</p>",
  "<h1>第二章 评审拆成「必须」与「可以」</h1><p>第二章正文。</p>",
  "<h1>第三章 下一季度的三件事</h1><p>第三章正文。</p>",
  "</article>",
  "</body></html>",
  "",
].join("\n");

const seed = (dir: string, html = HANDWRITTEN): string => {
  const path = join(dir, "doc.html");
  writeFileSync(path, html);
  return path;
};

const normalize = (dir: string, extra: readonly string[] = []): Promise<CliResult> =>
  runCli(["normalize", "doc.html", ...extra], { cwd: dir });

/** `--json` 的 `data` 字段（不写 `as`：断言走 `textOf`/`Number`）。 */
const dataOf = (result: CliResult): unknown => fieldOf(parseJsonLine(result.stdout), "data");

describe("hr normalize · 只看不写", () => {
  it("should report what it would inject on stdout without touching the file", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);
      const before = readFileSync(path, "utf8");

      const result = checked(await normalize(dir, ["--json"]));
      const data = dataOf(result);

      expect(result.code).toBe(0);
      expect(fieldOf(data, "needsNormalize")).toBe(true);
      expect(Number(fieldOf(data, "injected"))).toBeGreaterThan(0);
      // 打印出来的 html 是"补完 id 的样子"，用户能直接看到每个节点的 id。
      expect(textOf(fieldOf(data, "html"))).toContain("data-hr-id=");
      expect(textOf(fieldOf(data, "html"))).toContain("第一章 把发布节奏拉回来");
      // 关键：没 --write 就绝不落盘。
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  });

  it("should keep the human line on one line and say how many ids it added", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      const result = checked(await normalize(dir, ["--write"]));

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^normalized .*doc\.html \(\+\d+ ids, \d+ bytes\)\n$/u);
    });
  });
});

describe("hr normalize --write · 幂等", () => {
  it("should write ids to disk and report injected 0 on the second run", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);
      expect(checked(await normalize(dir, ["--write", "--json"])).code).toBe(0);
      const afterFirst = readFileSync(path, "utf8");
      expect(afterFirst).toContain("data-hr-id=");

      const second = checked(await normalize(dir, ["--write", "--json"]));

      // 幂等是这条命令存在的前提：否则用户重跑一次就换一批 id，之前拿到的 id 全失效。
      expect(fieldOf(dataOf(second), "needsNormalize")).toBe(false);
      expect(fieldOf(dataOf(second), "injected")).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(afterFirst);
    });
  });

  it("should leave every id the document already carries untouched", async () => {
    await withTempDir(async (dir) => {
      seed(
        dir,
        '<article data-hr-id="keep-a"><h2 data-hr-id="keep-b">已有 id</h2><p>没 id</p></article>',
      );

      expect(checked(await normalize(dir, ["--write"])).code).toBe(0);
      const written = readFileSync(join(dir, "doc.html"), "utf8");

      expect(written).toContain('data-hr-id="keep-a"');
      expect(written).toContain('data-hr-id="keep-b"');
      expect((written.match(/data-hr-id=/gu) ?? []).length).toBe(3);
    });
  });
});

describe("hr normalize · 不是文档", () => {
  it("should reject a file without <article> as invalid_document (exit 1)", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "just plain text");

      const result = checked(await normalize(dir, ["--json"]));
      const envelope = parseJsonLine(result.stdout);

      expect(result.code).toBe(1);
      expect(fieldOf(envelope, "ok")).toBe(false);
      expect(fieldOf(envelope, "code")).toBe("invalid_document");
      expect(textOf(fieldOf(envelope, "message"))).toContain("<article>");
    });
  });

  it("should name the file and the next step in human mode", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "");

      const result = checked(await normalize(dir));

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("<article>");
      // 别再让用户看到 `injectNodeIds` 这类内部函数名（B-02）。
      expect(result.stderr).not.toContain("injectNodeIds");
    });
  });
});
