// Concurrency: two real child processes racing `searchLibrary` on one workspace must
// both answer correctly and leave a valid index file — the index lock serializes the
// build, so neither process can interleave a partial write.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fieldOf, spawnFixture } from "../io/spawn";
import { writeTextAt, withWorkspace } from "../io/harness";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

describe("search index concurrency", () => {
  it("two racing processes both answer and the index survives", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植 手册"));
      await writeTextAt(join(dir, "b.html"), DOC("b", "钢铁 冶炼 原理"));

      // Both processes arrive at a missing index: both want to build + write it.
      const first = spawnFixture("search-worker.mjs", [dir, "苹果"]);
      const second = spawnFixture("search-worker.mjs", [dir, "钢铁"]);
      const [reportA, reportB] = await Promise.all([first.next(), second.next()]);
      await Promise.all([first.exit, second.exit]);

      expect(fieldOf(reportA, "ok")).toBe(true);
      expect(fieldOf(reportB, "ok")).toBe(true);
      expect(fieldOf(reportA, "paths")).toEqual(["a.html"]);
      expect(fieldOf(reportB, "paths")).toEqual(["b.html"]);

      // Whatever order the builds ran in, the surviving envelope parses and names both docs.
      const indexPath = join(dir, ".hreader", "index", "search.json");
      const parsed: unknown = JSON.parse(await readFile(indexPath, "utf8"));
      expect(Reflect.get(parsed as object, "version")).toBe(1);
      const docs = Reflect.get(parsed as object, "docs") as Record<string, unknown>;
      expect(Object.keys(docs).sort()).toEqual(["a.html", "b.html"]);
    });
  });
});
