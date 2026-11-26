// `data-hr-id` must match `^[A-Za-z][A-Za-z0-9_-]{0,63}$` and be unique across the doc.
// The two sides divide the work: `normalize` renames illegal/duplicate ids (keeping the first), while read/write
// entries (`read`/`outline`/`patch`) report `duplicate_id` (exit 2) on duplicates and name `hr normalize <file> --write`.

import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

const HR_ID_SHAPE = /^hr-[0-9a-f]{8}$/u;
const TOO_LONG = "a".repeat(65);
const REASSIGNED = [`1abc`, "中文", TOO_LONG, "a b"]
  .map((raw) => `<p data-hr-id="${raw}">X</p>`)
  .join("");

const docOf = (body: string): string =>
  ["<!doctype html>", "<html><head><title>t</title></head><body>", body, "</body></html>"].join(
    "\n",
  );

const idAttributesIn = (html: string): readonly string[] =>
  [...html.matchAll(/data-hr-id="([^"]*)"/gu)].map((match) => String(match[1]));

describe("normalize · id hygiene", () => {
  it("should reassign every id outside the pattern and leave valid ones alone", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, docOf(`<article>${REASSIGNED}</article>`));

      const result = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));

      expect(result.code).toBe(0);
      const ids = idAttributesIn(readFileSync(`${dir}/a.html`, "utf8"));
      // None of the four illegal ids may remain on disk: `1abc` starts non-letter, `中文` is non-ASCII, 65 chars too long, `a b` has a space.
      for (const raw of ["1abc", "中文", TOO_LONG, "a b"]) expect(ids).not.toContain(raw);
      // What remains is all hreader id shapes (`<article>` + four `<p>`s), pairwise distinct.
      expect(ids).toHaveLength(5);
      expect(ids.every((id) => HR_ID_SHAPE.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it("should keep the first of two duplicated ids and rename the later one", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(
        `${dir}/a.html`,
        docOf('<article><p data-hr-id="dup">甲</p><p data-hr-id="dup">乙</p></article>'),
      );

      checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));

      const ids = idAttributesIn(readFileSync(`${dir}/a.html`, "utf8"));
      // Keep the first (legal and earliest); the later one gets a new id: `<article>` + `dup` + new id.
      expect(ids.filter((id) => id === "dup")).toHaveLength(1);
      expect(ids).toHaveLength(3);
      expect(ids.filter((id) => id !== "dup").every((id) => HR_ID_SHAPE.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(3);
    });
  });
});

/** Two elements sharing `hr-c` in one doc: the load side (`read`/`outline`/`patch`) must all refuse. */
const DUPLICATED = docOf(
  '<article data-hr-id="hr-a"><p data-hr-id="hr-c">甲</p><p data-hr-id="hr-c">乙</p></article>',
);
const NEED_NORMALIZE_HINT = "先跑 hr normalize";

/** Run a call that must be refused; returns the exit code and the `--json` envelope (only "are these two right" remains to assert). */
const refusalOf = async (
  dir: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly envelope: unknown }> => {
  const result = checked(await runCli([...args, "--json"], { cwd: dir }));
  return { code: result.code, envelope: parseJsonLine(result.stdout) };
};

const expectDuplicateRefusalOf = async (dir: string, args: readonly string[]): Promise<void> => {
  const { code, envelope } = await refusalOf(dir, args);
  expect(code).toBe(2);
  expect(fieldOf(envelope, "code")).toBe("duplicate_id");
  expect(String(fieldOf(envelope, "message"))).toContain(NEED_NORMALIZE_HINT);
};

describe("read/outline/patch · the load side of duplicate ids", () => {
  it("should refuse `read` on both human and --json channels", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUPLICATED);

      const human = checked(await runCli(["read", "a.html", "hr-c"], { cwd: dir }));

      expect(human.code).toBe(2);
      expect(human.stderr).toContain(NEED_NORMALIZE_HINT);

      const { code, envelope } = await refusalOf(dir, ["read", "a.html", "hr-c"]);

      expect(code).toBe(2);
      expect(fieldOf(envelope, "ok")).toBe(false);
      expect(fieldOf(envelope, "code")).toBe("duplicate_id");
      expect(String(fieldOf(envelope, "message"))).toContain(NEED_NORMALIZE_HINT);
    });
  });

  it("should refuse `outline`", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUPLICATED);
      await expectDuplicateRefusalOf(dir, ["outline", "a.html"]);
    });
  });

  it("should refuse `patch` without touching a byte", async () => {
    await withTempDir(async (dir) => {
      const file = `${dir}/a.html`;
      writeFileSync(file, DUPLICATED);
      const before = readFileSync(file);

      await expectDuplicateRefusalOf(dir, ["patch", "a.html", "hr-c", "--action", "delete"]);
      // Refused write: not one byte may move when the load side refuses.
      expect(readFileSync(file).equals(before)).toBe(true);
    });
  });
});
