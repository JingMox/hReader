// 这层管：内容模型冲突（F6）的用户症状——往只装行内内容的容器里 append 块级子节点。
//
// 判定口径只到"写出去的字节与解析回来的树是同一棵"：`ul`/`table`/`select` 的子元素限制不在本层，
// 因此这里不写那些容器的用例。断言一律落到**磁盘**（sha256 / 字节），不看"有没有抛错"就算数。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checked, sha } from "./cli-support";
import { runCli, withTempDir, type CliResult } from "./harness";

const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a">',
  '<h1 data-hr-id="hr-h1">标题一</h1>',
  '<pre data-hr-id="hr-pre">code</pre>',
  '<p data-hr-id="hr-p">段落</p>',
  "</article>",
  "</body></html>",
].join("\n");

/** 子目录里的那份：路径回显与 round-trip 都要的是"用户给的那个相对串"。 */
const SUB_DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a1">',
  '<p data-hr-id="hr-c4">正文</p>',
  "</article>",
  "</body></html>",
].join("\n");

const NESTED_DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a">',
  '<ul data-hr-id="hr-list"><li data-hr-id="hr-li">一</li></ul>',
  // 表格内部（`tbody`/`tr`/`td`）自 F10 起也是可寻址元素：缺 id 的文档会先报 needs_normalize，
  // 所以夹具必须把它们补齐，否则这一组用例测的是「未规范化」而不是内容模型。
  '<table data-hr-id="hr-table"><tbody data-hr-id="hr-tbody"><tr data-hr-id="hr-tr">' +
    '<td data-hr-id="hr-td">c</td></tr></tbody></table>',
  "</article>",
  "</body></html>",
].join("\n");

/** 只装行内内容的三种容器：`p`（段落）、`pre`（预排版块）、`h1`（标题）。 */
const CONTAINERS = [
  { tag: "p", id: "hr-p" },
  { tag: "pre", id: "hr-pre" },
  { tag: "h1", id: "hr-h1" },
] as const;

const seedIn = (dir: string, name: string, html: string): string => {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, html);
  return path;
};

const patchJson = async (dir: string, args: readonly string[]): Promise<CliResult> =>
  checked(await runCli(["patch", ...args, "--json"], { cwd: dir }));

/** 被拒的改动：退出码 2 + `content_model_conflict` + 磁盘上一个字节都不动。 */
const expectConflictKeepingBytes = async (
  dir: string,
  file: string,
  args: readonly string[],
): Promise<CliResult> => {
  const before = sha(file);
  const result = await patchJson(dir, args);

  expect(result.code).toBe(2);
  expect(result.stdout).toContain('"code":"content_model_conflict"');
  expect(sha(file)).toBe(before);
  return result;
};

describe("F6 · 往 <p> 里 append 块级片段", () => {
  it("should leave the file byte-identical, not just throw", async () => {
    await withTempDir(async (dir) => {
      const file = seedIn(dir, join("sub", "b.html"), SUB_DOC);

      await expectConflictKeepingBytes(dir, file, [
        "sub/b.html",
        "hr-c4",
        "--action",
        "append",
        "--html",
        "<p>x</p>",
      ]);

      expect(readFileSync(file, "utf8")).toBe(SUB_DOC);
      // 也没有历史条目：被拒的改动不该留下可 undo 的痕迹（快照只在真写过之后才落盘）。
      expect(existsSync(join(dir, ".hreader", "history"))).toBe(false);
    });
  });
});

describe("F6 · 各容器拒块级 / 收行内", () => {
  it.each(CONTAINERS)("should reject a block child inside $tag", async ({ tag, id }) => {
    await withTempDir(async (dir) => {
      const file = seedIn(dir, "doc.html", DOC);

      const result = await expectConflictKeepingBytes(dir, file, [
        "doc.html",
        id,
        "--action",
        "append",
        "--html",
        "<p>插不进来</p>",
      ]);

      // 提示要把"能装块级"的容器名指出来，否则用户只会换个语法再撞一次。
      expect(result.stdout).toContain("<" + tag + ">");
    });
  });

  it.each(CONTAINERS)("should accept an inline child inside $tag", async ({ id }) => {
    await withTempDir(async (dir) => {
      const file = seedIn(dir, "doc.html", DOC);
      const before = sha(file);

      const result = checked(
        await runCli(["patch", "doc.html", id, "--action", "append", "--html", "<b>行内</b>"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(0);
      // 行内片段不带新 id（`+0`）：回执里不该冒出"新增了 id"的噪音。
      expect(result.stdout).toMatch(/^patched doc\.html \(\d+ bytes, \+0\)\n$/u);
      expect(sha(file)).not.toBe(before);
      expect(readFileSync(file, "utf8")).toContain("<b>行内</b>");
    });
  });
});

describe("F6 · replace 只看直接父容器", () => {
  it("should allow a div where the paragraph was, because the article holds it", async () => {
    await withTempDir(async (dir) => {
      const file = seedIn(dir, "doc.html", SUB_DOC);

      const result = await patchJson(dir, [
        "doc.html",
        "hr-c4",
        "--action",
        "replace",
        "--html",
        "<div>块</div>",
      ]);

      // 父容器是 `<article>`：装得下块级就是合法改动，不查祖先链。
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('"changed":true');
      expect(readFileSync(file, "utf8")).toContain("<div");
    });
  });
});

describe("F6 · 回执里的路径", () => {
  it("should echo the typed path and never an absolute one", async () => {
    await withTempDir(async (dir) => {
      seedIn(dir, join("sub", "b.html"), SUB_DOC);

      const result = checked(
        await runCli(["patch", "sub/b.html", "hr-c4", "--action", "append", "--html", "<b>k</b>"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("sub/b.html");
      // 反面：绝对路径（macOS 的 `realpathSync` 会把 `/var` 展开成 `/private/var`）不该进回执。
      expect(result.stdout).not.toContain("/private/");
      expect(result.stdout).not.toContain(dir);
    });
  });
});

describe("F6 · 目标容器装不下自己的同名子节点", () => {
  // 目标标签是块级、但解析器会把子节点拆成兄弟的那一种。`table` 的同类子标签（`tr`/`td`/`caption`/…）
  // 在片段校验层就先被拒（见下一条）；其余同类容器（`a`/`button`/`form`/`option`/`dd`/`dt`）
  // 选不成 patch 目标——它们由纯层测试守着。
  it("should refuse a nested <li> and keep the bytes", async () => {
    await withTempDir(async (dir) => {
      const file = seedIn(dir, "doc.html", NESTED_DOC);

      await expectConflictKeepingBytes(dir, file, [
        "doc.html",
        "hr-li",
        "--action",
        "append",
        "--html",
        "<li>二</li>",
      ]);

      expect(readFileSync(file, "utf8")).toBe(NESTED_DOC);
    });
  });
});

describe("F6 · 表格结构片段写错位置", () => {
  it("should refuse a bare table-row fragment and keep the bytes", async () => {
    await withTempDir(async (dir) => {
      const file = seedIn(dir, "doc.html", NESTED_DOC);
      const before = sha(file);

      const result = await patchJson(dir, [
        "doc.html",
        "hr-table",
        "--action",
        "append",
        "--html",
        "<tr><td>b</td></tr>",
      ]);

      // 片段本身能解析（F9 的 `CONTEXT_ANCESTORS` 会让 `<tr>` 在 `<table><tbody>` 上下文里解析），
      // 但直接追加到 `<table>` 上，解析器会替它补一层 `<tbody>` —— 写出去的树与解析回来的树不一致，
      // 所以在写盘前按内容模型拒绝，并给出下一步（往 `<tbody>` 上追加）。
      expect(result.code).toBe(2);
      expect(result.stdout).toContain('"code":"content_model_conflict"');
      expect(result.stdout).toContain("<tr>");
      expect(sha(file)).toBe(before);
    });
  });
});
