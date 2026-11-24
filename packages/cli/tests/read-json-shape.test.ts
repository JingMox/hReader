// `read --json` 的 `data` 形状恒定（`src/output.ts` 的 `dataRead`）。
// ① 四键恒在：`html` / `ids` / `truncated` / `diagnostics`；未截断时 `truncated === false`、
//    `diagnostics === []`——不是"键不存在"，也不是省略空数组；
// ② 截断时 `truncated === true` 且 `diagnostics` 里带 `truncated_output`（键集不变）；
// ③ 人读模式不能只在 JSON 里说截断：stdout 必须出现 `（已截断：` 那一行，否则用户会以为节点就这么长。
//
// 断言钉外部可观察物：`--json` 信封的键集与字段值、stdout 原文行。

import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fieldOf, keysOf, listOf, parseJsonLine, runCli, withTempDir } from "./harness";

/** 四个长段落：`<article>` 序列化后远大于下面的 `--max-bytes`，逼出截断。 */
const LONG: string = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  ...Array.from(
    { length: 8 },
    (_unused, index) => `<p data-hr-id="hr-p${String(index + 1)}">${"逐".repeat(40)}</p>`,
  ),
  "</article></body></html>",
].join("\n");

const SHORT: string = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  '<p data-hr-id="hr-p1">短</p>',
  "</article></body></html>",
].join("\n");

const TRUNCATED_FLAG = "truncated";

describe("read --json 的 data 四键恒定", () => {
  it("should always carry html/ids/truncated/diagnostics, with false/[] when nothing was cut", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, SHORT);
      const result = await runCli(["read", "a.html", "hr-root", "--json"], { cwd: dir });
      const data = fieldOf(parseJsonLine(result.stdout), "data");

      expect(result.code).toBe(0);
      expect(keysOf(data)).toEqual(["html", "ids", "truncated", "diagnostics"]);
      expect(fieldOf(data, TRUNCATED_FLAG)).toBe(false);
      expect(listOf(fieldOf(data, "diagnostics"))).toEqual([]);
    });
  });

  it("should keep the same four keys and report truncated_output when output is cut", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, LONG);
      const result = await runCli(["read", "a.html", "hr-root", "--max-bytes", "400", "--json"], {
        cwd: dir,
      });
      const data = fieldOf(parseJsonLine(result.stdout), "data");

      expect(result.code).toBe(0);
      expect(keysOf(data)).toEqual(["html", "ids", "truncated", "diagnostics"]);
      expect(fieldOf(data, TRUNCATED_FLAG)).toBe(true);
      const codes = listOf(fieldOf(data, "diagnostics")).map((item) => fieldOf(item, "code"));
      expect(codes).toContain("truncated_output");
    });
  });
});

describe("人读模式也要说截断", () => {
  it("should print a `（已截断：` line in human mode", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, LONG);
      const result = await runCli(["read", "a.html", "hr-root", "--max-bytes", "400"], {
        cwd: dir,
      });
      const lines = result.stdout.split("\n");
      const marked = lines.filter((line) => line.includes("（已截断："));

      expect(result.code).toBe(0);
      expect(marked).toHaveLength(1);
    });
  });
});
