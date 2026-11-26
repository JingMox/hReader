// This layer covers normalize's handling of HTML5 implicit end tags — a `<table>`/`<div>`/`<ul>` inside `<p>`
// must be split out as a sibling, not kept as a child; even a first `<p>` re-padded into a zero-length-span
// empty `<p>` must keep its author-written id (dropping it would make `#p-1` a straight `node_not_found`); after the split `<p>` still reads its own text by its own id, and a second normalize is `unchanged`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checked, seed } from "./cli-support";
import { runCli, withTempDir, fieldOf, parseJsonLine } from "./harness";

/** Just one `<article>` holding a bare `<p>` + an inlined block: exactly the input shape of this branch. */
const nestingDoc = (inner: string): string =>
  [
    "<!doctype html>",
    "<html><head><title>t</title></head><body>",
    `<article><p>前${inner}</p></article>`,
    "</body></html>",
  ].join("\n");

const CASES: readonly {
  readonly name: string;
  readonly inner: string;
  readonly blockTag: string;
}[] = [
  { name: "<table>", inner: "<table><tr><td>1</td></tr></table>", blockTag: "table" },
  { name: "<div>", inner: "<div>b</div>", blockTag: "div" },
  { name: "<ul>", inner: "<ul><li>b</li></ul>", blockTag: "ul" },
];

/** `<p>` may not contain `table`/`div`/`ul`: a correct split means a same-name block sits right after the p and is not inside it. */
const expectSplitOutOfParagraph = (html: string, blockTag: string): string => {
  const paragraph = /<p data-hr-id="([^"]+)">前<\/p>/u.exec(html);
  if (paragraph === null)
    throw new Error(`after normalize no <p> containing only "前" was found: ${html}`);
  const paragraphId = String(paragraph[1]);
  // A same-name block right after `<p …>前</p>` = it is the p's **sibling** (inside p this fragment could never appear).
  expect(html).toContain(`</p><${blockTag} data-hr-id=`);
  expect(html).not.toMatch(new RegExp(`<p[^>]*>[^<]*<${blockTag}`, "u"));
  return paragraphId;
};

describe("normalize · implicit end tags", () => {
  it.each(CASES)(
    "should split $name out of the paragraph and keep the paragraph addressable",
    async ({ inner, blockTag }) => {
      await withTempDir(async (dir) => {
        seed(dir, "a.html", nestingDoc(inner));

        const written = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
        expect(written.code).toBe(0);
        const paragraphId = expectSplitOutOfParagraph(
          readFileSync(`${dir}/a.html`, "utf8"),
          blockTag,
        );

        // The `<p>`'s id still points at its own text: splitting the block must not drag the anchor away.
        const read = checked(await runCli(["read", "a.html", paragraphId], { cwd: dir }));
        expect(read.stdout).toContain("前");
        expect(read.stdout).not.toContain(blockTag);
        expect(read.stdout).toContain(`data-hr-id="${paragraphId}"`);

        // A second normalize must not change a byte: one split is stable; each run must not rewrite bytes.
        const again = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
        expect(again.stdout).toMatch(/^unchanged a\.html \(\d+ bytes，已带齐 data-hr-id\)\n$/u);
      });
    },
  );
});
const FIRST_PIECE_ID = "p-1";

/**
 * No doctype = quirks: a block-level `<table>` inside `<p>` can only be moved out by `implicitClose`.
 * **No whitespace between `<p>` and `<table>`**: any whitespace text node in between makes the first
 * paragraph non-empty, and the branch being pinned is never reached.
 */
const EMPTY_FIRST_PIECE_DOC = [
  "<html><head><title>t</title></head><body>",
  `<article data-hr-id="hr-a"><p data-hr-id="${FIRST_PIECE_ID}"><table><tr><td>1</td></tr></table></p><p data-hr-id="p-2">后</p></article>`,
  "</body></html>",
].join("\n");

const htmlOf = (dir: string): string => readFileSync(`${dir}/a.html`, "utf8");

const normalized = async (dir: string): Promise<string> => {
  const result = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
  expect(result.code).toBe(0);
  return htmlOf(dir);
};

describe("normalize · the empty first paragraph's id · read back", () => {
  it("should keep the id on the empty paragraph and still read it back", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", EMPTY_FIRST_PIECE_DOC);

      const html = await normalized(dir);
      // The empty first paragraph and the moved-out table are **both** on-disk products: the empty `<p>` keeps its id, the table is its sibling.
      expect(html).toMatch(/<p data-hr-id="p-1"><\/p><table\b/u);

      const read = checked(
        await runCli(["read", "a.html", FIRST_PIECE_ID, "--json"], { cwd: dir }),
      );
      expect(read.code).toBe(0);
      const data = fieldOf(parseJsonLine(read.stdout), "data");
      expect(fieldOf(data, "html")).toBe('<p data-hr-id="p-1"></p>');
      // An id vanishing into thin air would surface as `id_reassigned`; here nothing was lost or renamed.
      expect(fieldOf(data, "diagnostics")).toEqual([]);
    });
  });
});

describe("normalize · the empty first paragraph's id · delete", () => {
  it("should delete only the empty paragraph and leave the moved table behind", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", EMPTY_FIRST_PIECE_DOC);
      await normalized(dir);

      // The zero-length-span boundary: this empty paragraph exists in source only as the bytes `<p …></p>` — delete must really remove it.
      const deleted = checked(
        await runCli(["patch", "a.html", FIRST_PIECE_ID, "--action", "delete"], { cwd: dir }),
      );
      expect(deleted.code).toBe(0);

      const html = htmlOf(dir);
      expect(html).not.toContain(FIRST_PIECE_ID);
      expect(html).toContain("<table");
      expect(html).toContain('data-hr-id="p-2"');
      expect(html).not.toMatch(/<p data-hr-id="p-1"/u);

      // The doc stays self-consistent after the delete: one more normalize changes nothing.
      const again = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
      expect(again.stdout).toMatch(/^unchanged a\.html \(\d+ bytes，已带齐 data-hr-id\)\n$/u);
    });
  });
});
const HR_ID_SHAPE = /^hr-[0-9a-f]{8}$/u;
const SPLIT_FIRST_ID = "hr-p1";

/** A quirks document (no doctype): only `implicitClose` moves this `<table>` out of `<p>`. */
const SPLIT_DOC = [
  "<html><head><title>t</title></head><body>",
  `<article data-hr-id="hr-a"><p data-hr-id="${SPLIT_FIRST_ID}">甲`,
  "<table><tr><td>1</td></tr></table>",
  "乙</p></article>",
  "</body></html>",
].join("\n");

/** All `data-hr-id` values in the file (in document order). */
const idsIn = (html: string): readonly string[] =>
  [...html.matchAll(/data-hr-id="([^"]*)"/gu)].map((match) => match[1] ?? "");

/** The `data-hr-id`s of the two `<p …>`s: exactly two paragraphs after normalization, in document order. */
const paragraphIdsIn = (html: string): readonly (string | undefined)[] =>
  [...html.matchAll(/<p\b[^>]*>/gu)].map((match) => /data-hr-id="([^"]+)"/u.exec(match[0])?.[1]);

const idsOfRead = async (dir: string, target: string): Promise<readonly string[]> => {
  const result = checked(await runCli(["read", "a.html", target, "--json"], { cwd: dir }));
  expect(result.code).toBe(0);
  const ids = fieldOf(fieldOf(parseJsonLine(result.stdout), "data"), "ids");
  if (!Array.isArray(ids)) throw new Error("read --json ids is not an array");
  return ids.map((id: unknown) => String(id));
};

/** The on-disk text after the split: two `<p>`s hugging a **sibling** table, whitespace between paragraph and block belonging to the earlier paragraph; returns both ids. */
const expectSplitShape = async (dir: string): Promise<readonly [string, string]> => {
  const html = await normalized(dir);
  expect(html).toMatch(/<p\b[^>]*>甲\s*<\/p><table\b/u);
  expect(html).toMatch(/<\/table><p\b[^>]*>\s*乙<\/p>/u);
  expect(html).not.toMatch(/<p\b[^>]*>[^<]*<table/u);

  const [firstId, secondId] = paragraphIdsIn(html);
  // First paragraph = the original element: id byte-identical; the second is **another** element with its own new id.
  expect(firstId).toBe(SPLIT_FIRST_ID);
  if (secondId === undefined) throw new Error("did not split into two <p>s");
  expect(secondId).toMatch(HR_ID_SHAPE);
  expect(secondId).not.toBe(SPLIT_FIRST_ID);

  // Every id in the doc corresponds 1:1 to an id-bearing element, all distinct (a duplicate id makes the load side refuse to read).
  const ids = idsIn(html);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expect.arrayContaining([SPLIT_FIRST_ID, secondId]));
  return [SPLIT_FIRST_ID, secondId];
};

/** `read --json`'s `ids` is the subtree of one paragraph: the first cannot reach the second's id — proof the two are really two nodes. */
const expectReadShape = async (dir: string, secondId: string): Promise<void> => {
  expect(await idsOfRead(dir, SPLIT_FIRST_ID)).toEqual([SPLIT_FIRST_ID]);
  const articleIds = await idsOfRead(dir, "hr-a");
  expect(new Set(articleIds).size).toBe(articleIds.length);
  expect(articleIds).toEqual(expect.arrayContaining([SPLIT_FIRST_ID, secondId]));
};

describe("normalize · a <p> split apart by a block element", () => {
  it("should keep the original id on the first piece and give the second piece its own id", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", SPLIT_DOC);

      const [, secondId] = await expectSplitShape(dir);
      await expectReadShape(dir, secondId);
    });
  });

  it("should delete only the first piece and leave the moved table and the second piece", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", SPLIT_DOC);
      const [, secondId] = await expectSplitShape(dir);

      const deleted = checked(
        await runCli(["patch", "a.html", SPLIT_FIRST_ID, "--action", "delete"], { cwd: dir }),
      );
      expect(deleted.code).toBe(0);

      // The first paragraph is gone; the moved-out table and the second paragraph are **both** there (each with its own range and id).
      const html = readFileSync(`${dir}/a.html`, "utf8");
      expect(idsIn(html)).not.toContain(SPLIT_FIRST_ID);
      expect(html).not.toContain("甲");
      expect(html).toContain("<table");
      expect(html).toContain("乙");
      expect(idsIn(html)).toContain(secondId);

      // The doc stays self-consistent after deleting the first paragraph: one more normalize changes nothing.
      const again = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
      expect(again.stdout).toMatch(/^unchanged a\.html \(\d+ bytes，已带齐 data-hr-id\)\n$/u);
      expect(idsIn(readFileSync(`${dir}/a.html`, "utf8"))).toContain(secondId);
    });
  });
});
