// Incremental indexing: edits re-index only the touched doc, deletes drop entries (and
// their annotations), an unchanged library never rewrites the index file, and a corrupt
// index rebuilds in full with one diagnostic.

import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import type { PatchDeps } from "../../src/io/ports";
import { addSidecarAnnotation } from "../../src/ops/sidecar-ops";
import { searchLibrary } from "../../src/search";
import { writeTextAt, withWorkspace } from "../io/harness";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

const INDEX = join(".hreader", "index", "search.json");

const find = (dir: string, query: string, deps = nodePatchDeps) =>
  searchLibrary({ workspace: dir, query }, deps);

/** `readFile` is the indexing choke point: wrapping it counts exactly which docs get re-read. */
const countingDeps = (seen: string[]): PatchDeps => ({
  ...nodePatchDeps,
  fs: {
    ...nodePatchDeps.fs,
    readFile: async (path: string) => {
      seen.push(path);
      return await nodePatchDeps.fs.readFile(path);
    },
  },
});

const docReadsOf = (seen: readonly string[], workspace: string): readonly string[] =>
  seen.filter((path) => path.startsWith(workspace) && path.endsWith(".html"));

describe("search index incremental updates", () => {
  it("re-indexes only the edited doc", async () => {
    await withWorkspace(async (dir) => {
      const workspaceReal = await nodePatchDeps.fs.realpath(dir);
      const aPath = join(dir, "a.html");
      const bPath = join(dir, "b.html");
      await writeTextAt(aPath, DOC("a", "苹果 种植 手册"));
      await writeTextAt(bPath, DOC("b", "钢铁 冶炼 原理"));
      await find(dir, "苹果");

      const seen: string[] = [];
      await writeTextAt(aPath, DOC("a", "葡萄 栽培 手册"));
      const result = await find(dir, "葡萄", countingDeps(seen));

      expect(result.results[0]?.path).toBe("a.html");
      const docReads = docReadsOf(seen, workspaceReal);
      // a.html gets re-read for indexing (+ once more as the hit's snippet source); b.html never.
      expect(docReads.length).toBeGreaterThan(0);
      for (const read of docReads) expect(read.endsWith("a.html")).toBe(true);
      expect(seen.some((path) => path.endsWith("b.html"))).toBe(false);
    });
  });

  it("drops a deleted doc — its annotation entries leave with it", async () => {
    await withWorkspace(async (dir) => {
      const bPath = join(dir, "b.html");
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await writeTextAt(bPath, DOC("b", "钢铁 冶炼"));
      await addSidecarAnnotation(
        {
          workspace: dir,
          file: "b.html",
          selector: "body > p:nth-of-type(1)",
          anchor: { exact: "钢铁", prefix: "", suffix: "", start: 0 },
          note: "高炉温度记录",
          author: "user",
        },
        nodePatchDeps,
      );
      const before = await find(dir, "高炉");
      expect(before.results[0]?.kind).toBe("annotation");

      await unlink(bPath);
      const after = await find(dir, "高炉");
      expect(after.results).toEqual([]);
      const docHits = await find(dir, "钢铁");
      expect(docHits.results).toEqual([]);
      // Only b's entries leave: the surviving doc must still answer.
      const surviving = await find(dir, "苹果");
      expect(surviving.results[0]?.path).toBe("a.html");
      // And the delete is persisted — the stored record forgets b.html.
      const stored = JSON.parse(await readFile(join(dir, INDEX), "utf8")) as {
        docs: Record<string, unknown>;
      };
      expect(stored.docs["b.html"]).toBeUndefined();
      expect(stored.docs["a.html"]).toBeDefined();
    });
  });

  it("an unchanged library never rewrites the index file", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await find(dir, "苹果");
      const indexPath = join(dir, INDEX);
      const mtime = (await stat(indexPath)).mtimeMs;
      await find(dir, "种植");
      expect((await stat(indexPath)).mtimeMs).toBe(mtime);
    });
  });

  it("a corrupt index rebuilds in full with one diagnostic", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await find(dir, "苹果");
      await writeTextAt(join(dir, INDEX), "{ not the index");
      const result = await find(dir, "苹果");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toContain("重建");
      // The healed file parses and carries the versioned envelope.
      const healed: unknown = JSON.parse(
        Buffer.from(await nodePatchDeps.fs.readFile(join(dir, INDEX))).toString("utf8"),
      );
      expect(Reflect.get(healed as object, "version")).toBe(1);
    });
  });

  it("an unknown-version index rebuilds the same way", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await find(dir, "苹果");
      const indexPath = join(dir, INDEX);
      const parsed = JSON.parse(
        Buffer.from(await nodePatchDeps.fs.readFile(indexPath)).toString("utf8"),
      ) as Record<string, unknown>;
      parsed["version"] = 999;
      await writeTextAt(indexPath, JSON.stringify(parsed));
      const result = await find(dir, "苹果");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics).toHaveLength(1);
    });
  });
});
