// 这组用例要证明：HTML5 允许**省略结束标签**的写法（`<li>a<li>b`）不会让 patch 变红，
// 并且写盘之后**再解析一次是同一棵树**——省略写法被补成规范形态，字节不再变动。
//
// 断言全部落在磁盘字节与真实进程输出上：rc、写盘后的规范形态、二次 `normalize` 的 `unchanged` 行、sha256 相等。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked, idOfTag, sha } from "./cli-support";
import { runCli, withTempDir } from "./harness";

const TABLE_BODY = "<table><tbody><tr><td>a</td></tr></tbody></table>";

const docOf = (body: string): string =>
  [
    "<!doctype html>",
    `<html><head><title>t</title></head><body><article><h1>标题</h1>${body}</article></body></html>`,
    "",
  ].join("\n");

/** 一个「可省略结束标签」的元素：往哪个容器 append、片段怎么写、盘上应该长成什么样。 */
interface OmittedEndTagCase {
  readonly tag: string;
  readonly container: string;
  readonly body: string;
  readonly fragment: string;
  readonly onDisk: RegExp;
}

/**
 * 覆盖 6 个代表元素（`li p td th dt option`）+ 表格行 `tr`。
 * 每行的 `onDisk` 都要求"结束标签被补齐"：写得进去但留个半开标签的实现会在这里红。
 */
const CASES: readonly OmittedEndTagCase[] = [
  {
    tag: "li",
    container: "ul",
    body: "<ul><li>a</li></ul>",
    fragment: "<li>b",
    onDisk: /<li data-hr-id="hr-[0-9a-f]{8}">b<\/li>/u,
  },
  {
    tag: "p",
    container: "div",
    body: "<div><p>a</p></div>",
    fragment: "<p>b",
    onDisk: /<p data-hr-id="hr-[0-9a-f]{8}">b<\/p>/u,
  },
  {
    tag: "tr",
    container: "tbody",
    body: TABLE_BODY,
    fragment: "<tr><td>b",
    onDisk: /<tr data-hr-id="hr-[0-9a-f]{8}"><td data-hr-id="hr-[0-9a-f]{8}">b<\/td><\/tr>/u,
  },
  {
    tag: "td",
    container: "tr",
    body: TABLE_BODY,
    fragment: "<td>b",
    onDisk: /<td data-hr-id="hr-[0-9a-f]{8}">b<\/td>/u,
  },
  {
    tag: "th",
    container: "tr",
    body: TABLE_BODY,
    fragment: "<th>b",
    onDisk: /<th data-hr-id="hr-[0-9a-f]{8}">b<\/th>/u,
  },
  {
    tag: "dt",
    container: "dl",
    body: "<dl><dt>a</dt></dl>",
    fragment: "<dt>b",
    onDisk: /<dt data-hr-id="hr-[0-9a-f]{8}">b<\/dt>/u,
  },
  {
    tag: "option",
    container: "div",
    body: "<div><p>a</p></div>",
    fragment: "<select><option>a<option>b</select>",
    // `select`/`option` 不是可寻址元素：新片段不带 id，但结束标签照样补齐。
    onDisk: /<select><option>a<\/option><option>b<\/option><\/select>/u,
  },
];

/** 给一个文件补 id（`select`/`option` 不在可寻址集合里，其余元素都该拿到 id）。 */
const normalizeIn = async (dir: string): Promise<number | null> =>
  checked(await runCli(["normalize", "doc.html", "--write"], { cwd: dir })).code;

/** 追加一个"结束标签省略"的片段，然后验证盘上的形态与二次解析的稳定性。 */
const appendOmitted = async (dir: string, item: OmittedEndTagCase): Promise<void> => {
  const file = join(dir, "doc.html");
  writeFileSync(file, docOf(item.body));
  expect(await normalizeIn(dir)).toBe(0);

  const targetId = idOfTag(readFileSync(file, "utf8"), item.container);
  const patched = checked(
    await runCli(["patch", "doc.html", targetId, "--action", "append", "--html", item.fragment], {
      cwd: dir,
    }),
  );

  expect(patched.code).toBe(0);
  expect(readFileSync(file, "utf8")).toMatch(item.onDisk);

  // 核心性质：写出去的字节与解析回来的树一致 —— 再跑一次 normalize 只报 unchanged、字节不差。
  const written = sha(file);
  const second = checked(await runCli(["normalize", "doc.html", "--write"], { cwd: dir }));
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("unchanged doc.html");
  expect(sha(file)).toBe(written);
};

describe("可省略结束标签的片段", () => {
  it.each(CASES)(
    "should accept a $tag fragment with its end tag omitted and keep the tree stable",
    async (item) => {
      await withTempDir((dir) => appendOmitted(dir, item));
    },
  );
});

/** 整段重写成只用省略结束标签的同一棵树：应当 rc=0、回执 `unchanged`、字节一个不动。 */
const rewriteListWithoutEndTags = async (dir: string): Promise<void> => {
  const file = join(dir, "doc.html");
  writeFileSync(file, docOf("<ul><li>a</li><li>b</li></ul>"));
  expect(await normalizeIn(dir)).toBe(0);
  const before = sha(file);
  const listId = idOfTag(readFileSync(file, "utf8"), "ul");

  const result = checked(
    await runCli(
      [
        "patch",
        "doc.html",
        listId,
        "--action",
        "replace",
        "--html",
        "<ul><li>a<li>b</li></li></ul>",
      ],
      { cwd: dir },
    ),
  );

  // 同一棵树 → 内容寻址的 id 也不变 → 这一改动等于什么都没改，回执必须是 unchanged。
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("unchanged doc.html");
  expect(sha(file)).toBe(before);
};

describe("整段重写只靠省略结束标签", () => {
  it("should treat a <ul> rewrite without end tags as the very same tree", async () => {
    await withTempDir(rewriteListWithoutEndTags);
  });

  it("should still refuse two real roots (an omitted end tag is not a second root)", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "doc.html");
      writeFileSync(file, docOf("<div><p>a</p></div>"));
      expect(await normalizeIn(dir)).toBe(0);
      const before = sha(file);
      const targetId = idOfTag(readFileSync(file, "utf8"), "div");

      const result = checked(
        await runCli(
          [
            "patch",
            "doc.html",
            targetId,
            "--action",
            "append",
            "--html",
            "<p>a</p><p>b</p>",
            "--json",
          ],
          { cwd: dir },
        ),
      );

      // 放宽"省略结束标签"不能顺手放宽根数：两个根仍然是不可执行的内容。
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"code":"invalid_fragment"');
      expect(result.stdout).toContain("根");
      expect(sha(file)).toBe(before);
    });
  });
});

describe("表格结构片段写错位置", () => {
  it("should name the next step when a <td> fragment would lose its structure", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "doc.html");
      writeFileSync(file, docOf("<div><p>a</p></div>"));
      expect(await normalizeIn(dir)).toBe(0);
      const before = sha(file);
      const targetId = idOfTag(readFileSync(file, "utf8"), "div");

      const result = checked(
        await runCli(
          ["patch", "doc.html", targetId, "--action", "append", "--html", "<td>b", "--json"],
          { cwd: dir },
        ),
      );

      // 片段本身能解析（省略了 `</td>`），但写进 `<div>` 解析回来就不再是 div 的子节点 → 写盘前拒绝。
      expect(result.code).toBe(2);
      expect(result.stdout).toContain('"code":"content_model_conflict"');
      // 报文要给出下一步：换成表格上下文，而不是让用户换个语法再撞一次。
      expect(result.stdout).toContain("<tbody>");
      expect(sha(file)).toBe(before);
    });
  });
});
