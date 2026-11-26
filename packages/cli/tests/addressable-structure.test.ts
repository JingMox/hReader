// These cases prove: `div` and table internals (`tbody`/`tr`/`td`) are all addressable and usable as
// patch targets after `normalize`, and a whole-table replace must not re-id untouched old rows — ids the user holds stay valid after the change.
//
// Assertions land on disk bytes and real process output; ids are read out of the file (`idOfTag`), never hardcoded.

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

/** Write the doc into the sandbox and inject ids (`--write`): addressability is a `normalize` product. */
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

describe("div is addressable and usable as a patch target", () => {
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

      // `div` used to be non-addressable: back then this went red for lack of an id.
      expect(result.code).toBe(0);
      expect(readFileSync(file, "utf8")).toMatch(/<p data-hr-id="hr-[0-9a-f]{8}">new<\/p>/u);
    });
  });
});

/** Append a row to `tbody`: rc=0, two rows and two cells on disk, and the new row/cell ids are assigned on write. */
const appendRowIntoTbody = async (dir: string): Promise<void> => {
  const file = await seedNormalized(dir, TABLE_DOC);
  const written = readFileSync(file, "utf8");
  const tbodyId = idOfTag(written, "tbody");

  // All three levels need ids: patching only up to `tr` still leaves `td` unreadable.
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
  // New row and new cell both carry ids: table-internal ids are not "copied" from the original file — they are assigned on write.
  expect(after.match(/<tr data-hr-id="hr-[0-9a-f]{8}"/gu) ?? []).toHaveLength(2);
  expect(after).toMatch(/<td data-hr-id="hr-[0-9a-f]{8}">b<\/td>/u);
};

describe("table internals are addressable", () => {
  it("should give tbody/tr/td ids and append a row into the tbody", async () => {
    await withTempDir(appendRowIntoTbody);
  });

  it("should read a cell back by its id", async () => {
    await withTempDir(async (dir) => {
      const file = await seedNormalized(dir, TABLE_DOC);
      const cellId = idOfTag(readFileSync(file, "utf8"), "td");

      const result = await readOf(dir, cellId);

      // `read` must stop on the cell: it returns that one `<td>`, not its parent row.
      expect(result.code).toBe(0);
      expect(htmlOf(result)).toBe(`<td data-hr-id="${cellId}">a</td>`);
    });
  });
});

/** Replace the whole table with two rows: old row/cell ids must stay literal on disk; new rows get new ids. */
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
  // The key assertion: untouched old rows/cells keep their literal ids on disk.
  // Anyone who changes the injector to "re-id every new subtree" makes these two lines red (all user-held ids die).
  expect(after).toContain(`data-hr-id="${rowId}"`);
  expect(after).toContain(`data-hr-id="${cellId}"`);
  // The added row is a new id; two rows and two cells in total.
  expect(after.match(/<tr data-hr-id="hr-[0-9a-f]{8}"/gu) ?? []).toHaveLength(2);
  expect(after.match(/<td data-hr-id="hr-[0-9a-f]{8}"/gu) ?? []).toHaveLength(2);
  expect(after).toMatch(/<td data-hr-id="hr-[0-9a-f]{8}">b<\/td>/u);
};

describe("whole-table replace keeps old row ids", () => {
  it("should keep the old tr and td ids while new rows get fresh ones", async () => {
    await withTempDir(replaceTableWithTwoRows);
  });
});

/** Nest a `<p>` inside `<p>`: rc=2, content-model conflict, the message names "paragraph" and containers that can hold it; bytes unchanged. */
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
  // The message only asserts "names paragraph + lists eligible containers", not the full text.
  expect(result.stdout).toContain("段落");
  expect(result.stdout).toContain("article/section/div");
  expect(sha(file)).toBe(before);
};

/** Nest a `<li>` inside `<li>`: the parser would restructure, so it is refused before write; bytes unchanged. */
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

/** Negative control: `td` holds flow, so a block-level fragment is legal. */
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

  // A stricter rule of "cells hold only inline" goes red here.
  expect(result.code).toBe(0);
  expect(readFileSync(file, "utf8")).toMatch(/<div data-hr-id="hr-[0-9a-f]{8}">块<\/div>/u);
};

describe("content-model message points out the next step", () => {
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

describe("normalize is idempotent", () => {
  it("should report unchanged on a document that already carries every id", async () => {
    await withTempDir(async (dir) => {
      const file = await seedNormalized(dir, TABLE_DOC);
      const before = sha(file);

      const second = checked(await runCli(["normalize", "doc.html", "--write"], { cwd: dir }));

      expect(second.code).toBe(0);
      // The human line says "all present": a second run must not re-id, nor silently rewrite bytes.
      expect(second.stdout).toContain("unchanged doc.html");
      expect(second.stdout).toContain("已带齐 data-hr-id");
      expect(sha(file)).toBe(before);
    });
  });
});
