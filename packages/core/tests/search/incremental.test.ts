// Incremental indexing: edits re-index only the touched doc, deletes drop entries (and
// their annotations), an unchanged library never rewrites the index file, and a corrupt
// index rebuilds in full with one diagnostic.

import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha1Hex } from "../../src/io/digest";
import { nodePatchDeps } from "../../src/io/node-fs";
import type { PatchDeps } from "../../src/io/ports";
import {
  addSidecarAnnotation,
  deleteSidecarAnnotation,
  resolveSidecarAnnotation,
} from "../../src/ops/sidecar-ops";
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

// Sidecar annotations mutate without touching their doc, so the incremental record also
// carries the sidecar store fingerprint: any mtime/size move re-indexes that doc's sidecar
// annotation entries only — the doc's own text is never re-read.
const seedSidecar = async (dir: string, file: string, note: string): Promise<string> => {
  const added = await addSidecarAnnotation(
    {
      workspace: dir,
      file,
      selector: "body > p:nth-of-type(1)",
      anchor: { exact: "摩托", prefix: "", suffix: "", start: 0 },
      note,
      author: "user",
    },
    nodePatchDeps,
  );
  return added.annotation.id;
};

const sidecarPath = (dir: string, rel: string): string =>
  join(dir, ".hreader", "annotations", `${sha1Hex(rel)}.json`);

const storedRecordOf = async (
  dir: string,
  rel: string,
): Promise<{ sidecar: { mtimeMs: number; size: number } | null } | undefined> => {
  const stored = JSON.parse(await readFile(join(dir, INDEX), "utf8")) as {
    docs: Record<string, { sidecar: { mtimeMs: number; size: number } | null }>;
  };
  return stored.docs[rel];
};

describe("search index sidecar freshness", () => {
  it("finds a sidecar annotation added to an unchanged doc", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await find(dir, "摩托");
      const id = await seedSidecar(dir, "a.html", "轮胎磨损记录");
      const result = await find(dir, "轮胎");
      const hit = result.results[0];
      expect(hit?.kind).toBe("annotation");
      expect(hit?.path).toBe("a.html");
      expect(hit?.annotationId).toBe(id);
    });
  });

  it("keeps a resolved annotation searchable and persists the new sidecar fingerprint", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      const id = await seedSidecar(dir, "a.html", "刹车异响");
      expect((await find(dir, "刹车")).results[0]?.annotationId).toBe(id);
      await resolveSidecarAnnotation(
        { workspace: dir, file: "a.html", id, resolutionNote: "已更换刹车片" },
        nodePatchDeps,
      );
      const after = await find(dir, "刹车");
      expect(after.results[0]?.kind).toBe("annotation");
      expect(after.results[0]?.annotationId).toBe(id);
      // The refresh persisted the new sidecar fingerprint into the stored record.
      const sidecarStat = await stat(sidecarPath(dir, "a.html"));
      expect(await storedRecordOf(dir, "a.html")).toEqual({
        sidecar: { mtimeMs: sidecarStat.mtimeMs, size: sidecarStat.size },
      });
    });
  });

  it("drops a deleted sidecar annotation on the next search", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      const id = await seedSidecar(dir, "a.html", "火花塞型号");
      expect((await find(dir, "火花塞")).results[0]?.annotationId).toBe(id);
      await deleteSidecarAnnotation({ workspace: dir, file: "a.html", id }, nodePatchDeps);
      expect((await find(dir, "火花塞")).results).toEqual([]);
      // The doc itself still answers.
      expect((await find(dir, "摩托")).results[0]?.path).toBe("a.html");
    });
  });

  it("does not re-read the doc when only its sidecar changed", async () => {
    await withWorkspace(async (dir) => {
      const workspaceReal = await nodePatchDeps.fs.realpath(dir);
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await find(dir, "摩托");
      await seedSidecar(dir, "a.html", "电瓶亏电");
      const seen: string[] = [];
      const result = await find(dir, "电瓶", countingDeps(seen));
      expect(result.results[0]?.kind).toBe("annotation");
      // The annotation entry refreshes from the sidecar alone — no doc read at all.
      expect(docReadsOf(seen, workspaceReal)).toEqual([]);
    });
  });

  it("a v1 index rebuilds once and then stays quiet", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await find(dir, "摩托");
      const indexPath = join(dir, INDEX);
      const parsed = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
      parsed["version"] = 1;
      await writeTextAt(indexPath, JSON.stringify(parsed));
      const rebuilt = await find(dir, "摩托");
      expect(rebuilt.results[0]?.path).toBe("a.html");
      expect(rebuilt.diagnostics.some((line) => line.includes("重建"))).toBe(true);
      expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({ version: 2 });
      // Second query: no rebuild, no write.
      const mtime = (await stat(indexPath)).mtimeMs;
      const again = await find(dir, "摩托");
      expect(again.diagnostics).toEqual([]);
      expect((await stat(indexPath)).mtimeMs).toBe(mtime);
    });
  });

  it("a corrupt sidecar reports a diagnostic while the doc still answers", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await seedSidecar(dir, "a.html", "火花塞间隙");
      expect((await find(dir, "火花塞")).results[0]?.kind).toBe("annotation");
      await writeTextAt(sidecarPath(dir, "a.html"), "{ not json");
      const result = await find(dir, "摩托");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics.length).toBeGreaterThan(0);
      // The stale annotation entry left with the corrupt store.
      expect((await find(dir, "火花塞")).results).toEqual([]);
    });
  });
});
