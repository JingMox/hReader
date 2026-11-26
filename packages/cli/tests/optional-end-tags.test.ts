// These cases prove: HTML5's **omissible end tags** (`<li>a<li>b`) do not make patch go red,
// and after the write **a re-parse yields the same tree** — the omitted form is completed to canonical shape and the bytes no longer move.
//
// All assertions land on disk bytes and real process output: rc, the canonical shape after write, a second `normalize`'s `unchanged` line, equal sha256.

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

/** One "omissible end tag" element: which container to append into, how the fragment reads, what it should look like on disk. */
interface OmittedEndTagCase {
  readonly tag: string;
  readonly container: string;
  readonly body: string;
  readonly fragment: string;
  readonly onDisk: RegExp;
}

/**
 * Covers 6 representative elements (`li p td th dt option`) + the table row `tr`.
 * Every row's `onDisk` requires "the end tag got completed": an implementation that writes but leaves a
 * half-open tag goes red here.
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
    // `select`/`option` are not addressable elements: the new fragment carries no id, but the end tags still get completed.
    onDisk: /<select><option>a<\/option><option>b<\/option><\/select>/u,
  },
];

/** Inject ids into a file (`select`/`option` are outside the addressable set; every other element must get an id). */
const normalizeIn = async (dir: string): Promise<number | null> =>
  checked(await runCli(["normalize", "doc.html", "--write"], { cwd: dir })).code;

/** Append an "end-tag-omitted" fragment, then verify the on-disk shape and re-parse stability. */
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

  // The core property: written bytes and the re-parsed tree agree — a second normalize only reports unchanged, bytes equal.
  const written = sha(file);
  const second = checked(await runCli(["normalize", "doc.html", "--write"], { cwd: dir }));
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("unchanged doc.html");
  expect(sha(file)).toBe(written);
};

describe("fragments with omissible end tags", () => {
  it.each(CASES)(
    "should accept a $tag fragment with its end tag omitted and keep the tree stable",
    async (item) => {
      await withTempDir((dir) => appendOmitted(dir, item));
    },
  );
});

/** Rewrite the whole section to the same tree using only omitted end tags: expect rc=0, an `unchanged` receipt, not one byte moved. */
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

  // Same tree → same content-derived ids → this edit equals no edit; the receipt must be unchanged.
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("unchanged doc.html");
  expect(sha(file)).toBe(before);
};

describe("a whole-section rewrite using only omitted end tags", () => {
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

      // Loosening "omitted end tags" must not loosen the root count along with it: two roots remain inexecutable content.
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"code":"invalid_fragment"');
      expect(result.stdout).toContain("根");
      expect(sha(file)).toBe(before);
    });
  });
});

describe("a table-structure fragment written to the wrong place", () => {
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

      // The fragment itself parses (`</td>` omitted), but written into `<div>` it re-parses outside the div's children → refuse before write.
      expect(result.code).toBe(2);
      expect(result.stdout).toContain('"code":"content_model_conflict"');
      // The message must give a next step: switch to a table context, not make the user retry with another syntax.
      expect(result.stdout).toContain("<tbody>");
      expect(sha(file)).toBe(before);
    });
  });
});
