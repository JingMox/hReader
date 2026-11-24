// 这组用例要证明：`div` 与表格内部（`tbody`/`tr`/`td`）在 `normalize` 之后**都可寻址、可作 patch 目标**，
// 并且「整表 replace」不会给没被改动的老行换 id —— 用户手里那批 id 在改动之后仍然有效。
//
// 断言落在磁盘字节与真实进程输出上；id 一律从文件里读出来比（`idOfTag`），不硬编码。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked, idOfTag, sha } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, textOf, withTempDir, type CliResult } from "./harness";

const TABLE_DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body><article><h1>标题</h1>",
  "<table><tbody><tr><td>a</td></tr></tbody></table>",
  "</article></body></html>",
  "",
].join("\n");

const MIXED_DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body><article><h1>标题</h1>",
  "<div><p>x</p></div><p>段落</p><ul><li>一</li></ul>",
  "</article></body></html>",
  "",
].join("\n");

const fileOf = (dir: string): string => join(dir, "doc.html");

/** 把文档写进沙箱并补 id（`--write`）：可寻址性本来就是 `normalize` 的产物。 */
const seedNormalized = async (dir: string, html: string): Promise<string> => {
  writeFileSync(fileOf(dir), html);
  expect(checked(await runCli(["normalize", "doc.html", "--write"], { cwd: dir })).code).toBe(0);
  return fileOf(dir);
};

const patch = (dir: string, args: readonly string[]): Promise<CliResult> =>
  runCli(["patch", ...args, "--json"], { cwd: dir }).then(checked);

const readOf = async (dir: string, nodeId: string): Promise<CliResult> =>
  checked(await runCli(["read", "doc.html", nodeId, "--json"], { cwd: dir }));

const htmlOf = (result: CliResult): string =>
  textOf(fieldOf(fieldOf(parseJsonLine(result.stdout), "data"), "html"));

describe("div 可寻址、可作目标", () => {
  it("should give the div an id on normalize and accept it as a patch target", async () => {
    await withTempDir(async (dir) => {
      const file = await seedNormalized(dir, MIXED_DOC);
      const divId = idOfTag(readFileSync(file, "utf8"), "div");

      const result = await patch(dir, [
        "doc.html",
        divId,
        "--action",
        "append",
        "--html",
        "<p>new</p>",
      ]);

      // `div` 曾经不是可寻址元素：那时这里会因为拿不到 id 而红。
      expect(result.code).toBe(0);
      expect(readFileSync(file, "utf8")).toMatch(/<p data-hr-id="hr-[0-9a-f]{8}">new<\/p>/u);
    });
  });
});

/** 往 `tbody` 追加一行：rc=0，盘上有两行两格，且新行/新格的 id 是写盘时分配的。 */
const appendRowIntoTbody = async (dir: string): Promise<void> => {
  const file = await seedNormalized(dir, TABLE_DOC);
  const written = readFileSync(file, "utf8");
  const tbodyId = idOfTag(written, "tbody");

  // 三层都得有 id：只补到 `tr` 的话 `td` 仍然 read 不到。
  expect(idOfTag(written, "tr")).toMatch(/^hr-[0-9a-f]{8}$/u);
  expect(idOfTag(written, "td")).toMatch(/^hr-[0-9a-f]{8}$/u);

  const result = await patch(dir, [
    "doc.html",
    tbodyId,
    "--action",
    "append",
    "--html",
    "<tr><td>b</td></tr>",
  ]);

  expect(result.code).toBe(0);
  const after = readFileSync(file, "utf8");
  // 新行、新单元格都带 id：表格内部的 id 不是在原文件里"抄"来的，是写盘时分配的。
  expect(after.match(/<tr data-hr-id="hr-[0-9a-f]{8}"/gu) ?? []).toHaveLength(2);
  expect(after).toMatch(/<td data-hr-id="hr-[0-9a-f]{8}">b<\/td>/u);
};

describe("表格内部可寻址", () => {
  it("should give tbody/tr/td ids and append a row into the tbody", async () => {
    await withTempDir(appendRowIntoTbody);
  });

  it("should read a cell back by its id", async () => {
    await withTempDir(async (dir) => {
      const file = await seedNormalized(dir, TABLE_DOC);
      const cellId = idOfTag(readFileSync(file, "utf8"), "td");

      const result = await readOf(dir, cellId);

      // `read` 必须能停在单元格上：返回的就是那一个 `<td>`，不是它的父行。
      expect(result.code).toBe(0);
      expect(htmlOf(result)).toBe(`<td data-hr-id="${cellId}">a</td>`);
    });
  });
});

/** 整表 replace 成两行：老行/老格的 id 必须原样留在盘上，新行拿新 id。 */
const replaceTableWithTwoRows = async (dir: string): Promise<void> => {
  const file = await seedNormalized(dir, TABLE_DOC);
  const before = readFileSync(file, "utf8");
  const tableId = idOfTag(before, "table");
  const rowId = idOfTag(before, "tr");
  const cellId = idOfTag(before, "td");

  const result = await patch(dir, [
    "doc.html",
    tableId,
    "--action",
    "replace",
    "--html",
    "<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>",
  ]);

  expect(result.code).toBe(0);
  const after = readFileSync(file, "utf8");
  // 最关键的一条：没被改动的老行/老单元格，id 字面值必须还在盘上。
  // 谁把注入器改成"整棵新子树一律重发 id"，这两行就红（用户手里的 id 会全部失效）。
  expect(after).toContain(`data-hr-id="${rowId}"`);
  expect(after).toContain(`data-hr-id="${cellId}"`);
  // 新加的那一行是新 id，共有两行两格。
  expect(after.match(/<tr data-hr-id="hr-[0-9a-f]{8}"/gu) ?? []).toHaveLength(2);
  expect(after.match(/<td data-hr-id="hr-[0-9a-f]{8}"/gu) ?? []).toHaveLength(2);
  expect(after).toMatch(/<td data-hr-id="hr-[0-9a-f]{8}">b<\/td>/u);
};

describe("整表 replace 保住老行 id", () => {
  it("should keep the old tr and td ids while new rows get fresh ones", async () => {
    await withTempDir(replaceTableWithTwoRows);
  });
});

/** 往 `<p>` 里塞 `<p>`：rc=2、内容模型冲突、报文说得出"段落"和能装的容器、字节不动。 */
const appendParagraphIntoParagraph = async (dir: string): Promise<void> => {
  const file = await seedNormalized(dir, MIXED_DOC);
  const before = sha(file);
  const paragraphId = idOfTag(readFileSync(file, "utf8"), "p");

  const result = await patch(dir, [
    "doc.html",
    paragraphId,
    "--action",
    "append",
    "--html",
    "<p>子</p>",
  ]);

  expect(result.code).toBe(2);
  expect(result.stdout).toContain('"code":"content_model_conflict"');
  // 报文只断"点出段落 + 给出能装的容器"，不断全文。
  expect(result.stdout).toContain("段落");
  expect(result.stdout).toContain("article/section/div");
  expect(sha(file)).toBe(before);
};

/** 往 `<li>` 里塞 `<li>`：解析器会改结构，所以写盘前拒，字节不动。 */
const appendListItemIntoListItem = async (dir: string): Promise<void> => {
  const file = await seedNormalized(dir, MIXED_DOC);
  const before = sha(file);
  const itemId = idOfTag(readFileSync(file, "utf8"), "li");

  const result = await patch(dir, [
    "doc.html",
    itemId,
    "--action",
    "append",
    "--html",
    "<li>二</li>",
  ]);

  expect(result.code).toBe(2);
  expect(result.stdout).toContain('"code":"content_model_conflict"');
  expect(result.stdout).toContain("会改结构");
  expect(sha(file)).toBe(before);
};

/** 反面对照：`td` 装 flow，块级片段合法。 */
const appendDivIntoCell = async (dir: string): Promise<void> => {
  const file = await seedNormalized(dir, TABLE_DOC);
  const cellId = idOfTag(readFileSync(file, "utf8"), "td");

  const result = await patch(dir, [
    "doc.html",
    cellId,
    "--action",
    "append",
    "--html",
    "<div>块</div>",
  ]);

  // 判严成"单元格只装行内"会在这里红。
  expect(result.code).toBe(0);
  expect(readFileSync(file, "utf8")).toMatch(/<div data-hr-id="hr-[0-9a-f]{8}">块<\/div>/u);
};

describe("内容模型报文指得出下一步", () => {
  it("should tell the user a <p> is a paragraph and name a container that holds one", async () => {
    await withTempDir(appendParagraphIntoParagraph);
  });

  it("should refuse a nested <li> as a parser-tree change and keep the bytes", async () => {
    await withTempDir(appendListItemIntoListItem);
  });

  it("should accept a div inside a td because a cell holds flow content", async () => {
    await withTempDir(appendDivIntoCell);
  });
});

describe("normalize 幂等", () => {
  it("should report unchanged on a document that already carries every id", async () => {
    await withTempDir(async (dir) => {
      const file = await seedNormalized(dir, TABLE_DOC);
      const before = sha(file);

      const second = checked(await runCli(["normalize", "doc.html", "--write"], { cwd: dir }));

      expect(second.code).toBe(0);
      // 人读行明说"已带齐"：再跑一次不该换 id，也不该悄悄重写字节。
      expect(second.stdout).toContain("unchanged doc.html");
      expect(second.stdout).toContain("已带齐 data-hr-id");
      expect(sha(file)).toBe(before);
    });
  });
});
