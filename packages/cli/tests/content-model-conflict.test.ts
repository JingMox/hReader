// This layer covers the user symptom of a content-model conflict — appending a block-level child into a container that only holds inline content.
//
// The judgment only goes as far as "the bytes written re-parse to the same tree": `ul`/`table`/`select` child
// restrictions live elsewhere, so no cases for those containers here. Assertions always land on **disk** (sha256 / bytes) — "did it throw" does not count.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assertNoHostPaths } from "../../../tests/adversarial/no-host-paths.ts";
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

/** The copy inside a subdirectory: both path echo and round-trip want "the relative string the user gave". */
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
  // Table internals (`tbody`/`tr`/`td`) are also addressable: a doc missing their ids reports needs_normalize
  // first, so the fixture must fill them in — otherwise this group tests "unnormalized", not the content model.
  '<table data-hr-id="hr-table"><tbody data-hr-id="hr-tbody"><tr data-hr-id="hr-tr">' +
    '<td data-hr-id="hr-td">c</td></tr></tbody></table>',
  "</article>",
  "</body></html>",
].join("\n");

/** Three containers that only hold inline content: `p` (paragraph), `pre` (preformatted block), `h1` (heading). */
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

/** The refused edit: exit 2 + `content_model_conflict` + not one byte moved on disk. */
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

describe("appending a block-level fragment into <p>", () => {
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
      // No history entry either: a refused edit must not leave an undoable trace (the snapshot lands only after a real write).
      expect(existsSync(join(dir, ".hreader", "history"))).toBe(false);
    });
  });
});

describe("each container refuses block / accepts inline", () => {
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

      // The hint must name containers that "can hold blocks", otherwise the user just picks another syntax and trips again.
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
      // An inline fragment carries no new ids (`+0`): no "ids added" noise may appear in the receipt.
      expect(result.stdout).toMatch(/^patched doc\.html \(\d+ bytes, \+0\)\n$/u);
      expect(sha(file)).not.toBe(before);
      expect(readFileSync(file, "utf8")).toContain("<b>行内</b>");
    });
  });
});

describe("replace only looks at the direct parent container", () => {
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

      // The parent container is `<article>`: holding a block is legal there, ancestors are not consulted.
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('"changed":true');
      expect(readFileSync(file, "utf8")).toContain("<div");
    });
  });
});

describe("paths in the receipt", () => {
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
      // Negative: an absolute path (macOS `realpathSync` expands `/var` to `/private/var`) must not appear in the receipt.
      expect(result.stdout).not.toContain("/private/");
      expect(result.stdout).not.toContain(dir);
      // Shared checker: no host root and neither spelling of the workspace path may leak.
      assertNoHostPaths(result.stdout, [dir, realpathSync(dir)]);
    });
  });
});

describe("a target container that cannot hold its own same-name child", () => {
  // The target tag is block-level, but the parser would reparent its children as siblings. `table`'s same-family
  // children (`tr`/`td`/`caption`/…) are refused earlier at the fragment layer (see the next case); the other
  // same-family containers (`a`/`button`/`form`/`option`/`dd`/`dt`) cannot be picked as patch targets — pure-layer tests guard them.
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

describe("a table-structure fragment written to the wrong place", () => {
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

      // The fragment itself parses (core's `CONTEXT_ANCESTORS` lets `<tr>` parse inside a `<table><tbody>` context),
      // but appended directly to `<table>`, the parser inserts a `<tbody>` for it — the written tree differs from the
      // re-parsed tree, so it is refused before write with a next step (append to `<tbody>` instead).
      expect(result.code).toBe(2);
      expect(result.stdout).toContain('"code":"content_model_conflict"');
      expect(result.stdout).toContain("<tr>");
      expect(sha(file)).toBe(before);
    });
  });
});
