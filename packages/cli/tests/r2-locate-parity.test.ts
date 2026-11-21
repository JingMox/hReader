// R2-F18（docs/05:120 AC1「`hr read <file> <nodeId|selector>`」+ docs/05:98 AC9「同一解析器」）：
// ① 同一个元素的两种寻址方式（标签选择器 / 它的 `data-hr-id`）必须产出**逐字节相同**的输出；
// ② 不可寻址元素（行内 `<span>`，规范化也不给 id）只能靠选择器命中，两条选择器路径同样必须逐字节相同；
// ③ 用选择器 patch 落盘后，**文档根元素的 id 不变**（id 归产品所有，patch 只动被指的那棵子树）。
//
// 断言钉外部可观察物：stdout 原文逐字节比较、退出码、落盘字节；不看内部返回值。

import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-root"><section data-hr-id="hr-sec">',
  '<p data-hr-id="hr-p">前<span>甲</span>中<span>乙</span>后</p>',
  '<ul data-hr-id="hr-u"><li data-hr-id="hr-l1">一</li><li data-hr-id="hr-l2">二</li></ul>',
  "</section></article>",
  "</body></html>",
].join("\n");

const ROOT_OPEN = '<article data-hr-id="hr-root">';

/** 跑一条必须成功的命令，返回 stdout 原文（逐字节比较的对象）。 */
const stdoutOf = async (dir: string, args: readonly string[]): Promise<string> => {
  const result = checked(await runCli(args, { cwd: dir }));
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
};

const seed = (dir: string): string => {
  const file = `${dir}/a.html`;
  writeFileSync(file, DOC);
  return file;
};

const dataOf = (envelope: unknown): unknown => fieldOf(envelope, "data");

/** 跑一条 `read --json` 并取 `data`（整份 JSON 不再要求逐字节相同，比较下沉到字段）。 */
const readDataOf = async (dir: string, target: string): Promise<unknown> =>
  dataOf(parseJsonLine(await stdoutOf(dir, ["read", "a.html", target, "--json"])));

const diagnosticCodesOf = (data: unknown): readonly unknown[] => {
  const diagnostics: unknown = fieldOf(data, "diagnostics");
  return Array.isArray(diagnostics)
    ? diagnostics.map((diagnostic) => fieldOf(diagnostic, "code"))
    : [];
};

/** 真正描述元素的三个字段必须一致；`diagnostics` 不在此列（歧义警告随选择器变）。 */
const expectSameReadData = (left: unknown, right: unknown): void => {
  for (const key of ["html", "ids", "truncated"]) {
    expect(fieldOf(left, key)).toEqual(fieldOf(right, key));
  }
};

/**
 * 不可寻址元素的两路 parity：人读 HTML 与 `data` 三字段逐字节相同；
 * 但 `span` 命中 2 个必须带 `ambiguous_selector`，子选择器命中 1 个不得带。
 * 不再要求整份 JSON 相同：警告讲的是“选择器有歧义”，不是“这个元素是谁”。
 */
const expectSpanParity = async (dir: string): Promise<void> => {
  const byTag = await stdoutOf(dir, ["read", "a.html", "span"]);
  const byChild = await stdoutOf(dir, ["read", "a.html", "p > span:nth-of-type(1)"]);
  expect(byChild).toBe(byTag);
  expect(byTag).toContain("<span>甲</span>");

  const dataByTag = await readDataOf(dir, "span");
  const dataByChild = await readDataOf(dir, "p > span:nth-of-type(1)");
  expectSameReadData(dataByTag, dataByChild);
  // 护栏：默认取第一个不能被静默允许。
  expect(diagnosticCodesOf(dataByTag)).toContain("ambiguous_selector");
  expect(diagnosticCodesOf(dataByChild)).not.toContain("ambiguous_selector");
};

describe("read · 两种寻址路径的逐字节一致性（F18 / docs/05:120）", () => {
  it("should print the same bytes for `read ul` and `read <that ul's id>`", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      // 同一份 html（HumanRead 通道）。
      const byTag = await stdoutOf(dir, ["read", "a.html", "ul"]);
      const byId = await stdoutOf(dir, ["read", "a.html", "hr-u"]);
      expect(byId).toBe(byTag);

      // `--json` 同样逐字节：`data` 里没有任何「寻址来源」字段会因入口不同而变。
      const jsonByTag = await stdoutOf(dir, ["read", "a.html", "ul", "--json"]);
      const jsonById = await stdoutOf(dir, ["read", "a.html", "hr-u", "--json"]);
      expect(jsonById).toBe(jsonByTag);
      expect(jsonById).toContain('"html":"<ul data-hr-id=\\"hr-u\\">');
    });
  });

  it("should print the same bytes for an unaddressable element reached two ways", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      // `<span>` 在盘上没有 `data-hr-id`：只能靠选择器摸进去，且两条选择器都得落到同一个元素上。
      // 人读通道仍逐字节相同；`--json` 不再要求整份相同（`span` 带歧义警告、子选择器不带，见 helper 注释）。
      await expectSpanParity(dir);
    });
  });
});

describe("patch · 用选择器定位后根 id 不变（F18 / docs/05:98）", () => {
  it("should keep the document root's id after a selector-addressed patch", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir);

      const result = checked(
        await runCli(["patch", "a.html", "ul", "--action", "append", "--html", "<li>三</li>"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(0);
      // 落盘后根元素的开标签逐字不变（id 是内容派生的，选择器定位不许把它换掉）。
      const after = readFileSync(file, "utf8");
      expect(after).toContain(ROOT_OPEN);
      expect(after.match(/data-hr-id="hr-root"/gu)).toHaveLength(1);
      // 根仍然按老 id 读得到，且读到的是打过补丁的那棵树。
      const root = await stdoutOf(dir, ["read", "a.html", "hr-root"]);
      expect(root).toContain("三</li>");
      // 目标 `<ul>` 自己的 id 也没变：新 `<li>` 有 id，`<ul>` 还是 `hr-u`。
      expect(after).toContain('<ul data-hr-id="hr-u">');
    });
  });

  it("should keep the root id even when the patched target is the root itself", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir);

      const result = checked(
        await runCli(["patch", "a.html", "article", "--action", "append", "--html", "<p>尾</p>"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(0);
      expect(readFileSync(file, "utf8")).toContain(ROOT_OPEN);
    });
  });
});
