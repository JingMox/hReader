// R3-D5（.workflow/cards/R3.md D5 + docs/05:424 选择器方言）：文档里合法的 `data-hr-id` 可以带大写与
// 下划线（`hr-Ab12` / `hr_Ab_12`），所以选择器方言必须**逐字**匹配 id，不能先做大小写归一：
// ① `#hr-Ab12` 取到的是大写那个；文档里同时存在 `hr-ab12` 时两者**各归各**（不做 case-fold）；
// ② 裸 id 同理（回退链不区分大小写才算通过）；
// ③ `_` 在 `#id` 与裸 id 两条路上都通。
//
// 断言钉外部可观察物：退出码、`--json` 的 `data.html` 原文。

import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

const DOC = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  '<p data-hr-id="hr-Ab12">大写那一个</p>',
  '<p data-hr-id="hr-ab12">小写那一个</p>',
  '<p data-hr-id="hr_Ab_12">下划线那一个</p>',
  "</article></body></html>",
].join("\n");

const htmlOf = async (dir: string, target: string): Promise<string> => {
  const result = await runCli(["read", "a.html", target, "--json"], { cwd: dir });
  expect(result.code).toBe(0);
  return String(fieldOf(fieldOf(parseJsonLine(result.stdout), "data"), "html"));
};

describe("D5 · id 逐字匹配（大写/下划线）", () => {
  it("should resolve #hr-Ab12 to the uppercase id", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DOC);
      const html = await htmlOf(dir, "#hr-Ab12");

      expect(html).toContain('data-hr-id="hr-Ab12"');
      expect(html).toContain("大写那一个");
    });
  });

  it("should keep hr-Ab12 and hr-ab12 apart instead of case-folding", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DOC);

      expect(await htmlOf(dir, "#hr-ab12")).toContain("小写那一个");
      expect(await htmlOf(dir, "hr-Ab12")).toContain("大写那一个");
      expect(await htmlOf(dir, "hr-ab12")).toContain("小写那一个");
    });
  });

  it("should resolve ids containing underscores on both the #id and bare-id paths", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DOC);

      expect(await htmlOf(dir, "#hr_Ab_12")).toContain("下划线那一个");
      expect(await htmlOf(dir, "hr_Ab_12")).toContain("下划线那一个");
    });
  });
});
