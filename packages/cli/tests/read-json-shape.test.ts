// `read --json`'s `data` shape is constant (`src/output.ts`'s `dataRead`).
// ① Four keys always present: `html` / `ids` / `truncated` / `diagnostics`; untruncated means `truncated === false`,
//    `diagnostics === []` — not "key absent", not an elided empty array;
// ② Truncated means `truncated === true` and `diagnostics` carries `truncated_output` (key set unchanged);
// ③ Human mode must not say "truncated" only in JSON: stdout must show the `（已截断：` line, or the user thinks the node is just that long.
//
// Assertions pin external observables: the `--json` envelope's key set and field values, raw stdout lines.

import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fieldOf, keysOf, listOf, parseJsonLine, runCli, withTempDir } from "./harness";

/** Four long paragraphs: `<article>` serializes far beyond the `--max-bytes` below, forcing truncation. */
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

describe("read --json's four data keys are constant", () => {
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

describe("human mode must say it is truncated too", () => {
  it("should print the truncation line in human mode", async () => {
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
