// Tag search: a doc's tags are indexed as their own boosted field, the hit carries the
// stored tag list, a tag edit re-indexes only that doc (bytes untouched), and the meta
// fingerprint in the per-doc record is what notices an otherwise invisible tag change.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import MiniSearch from "minisearch";
import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import type { PatchDeps } from "../../src/io/ports";
import { getDocMeta, setDocMeta } from "../../src/ops/doc-meta-ops";
import { searchLibrary } from "../../src/search";
import { writeTextAt, withWorkspace } from "../io/harness";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

const INDEX = join(".hreader", "index", "search.json");

const find = (dir: string, query: string, deps = nodePatchDeps) =>
  searchLibrary({ workspace: dir, query }, deps);

const tag = async (dir: string, file: string, tags: readonly string[]): Promise<void> => {
  await setDocMeta({ workspace: dir, file, patch: { tags: [...tags] }, by: "user" }, nodePatchDeps);
};

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

/** `meta.json` reads as EACCES — the whole table is invisible, docs and index stay readable. */
const metaBlindDeps: PatchDeps = {
  ...nodePatchDeps,
  fs: {
    ...nodePatchDeps.fs,
    readFile: async (path: string) => {
      if (path.endsWith(join("meta.json"))) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return await nodePatchDeps.fs.readFile(path);
    },
  },
};

describe("search · doc tags", () => {
  it("finds a doc by one of its tags and echoes the stored list", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await tag(dir, "a.html", ["读书笔记", "植物"]);

      const result = await find(dir, "读书笔记");

      expect(result.results).toHaveLength(1);
      const hit = result.results[0];
      expect(hit?.path).toBe("a.html");
      expect(hit?.kind).toBe("doc");
      expect(hit?.tags).toEqual(["读书笔记", "植物"]);
      // The tag field is the snippet source — the doc's own bytes never mentioned the term.
      expect(hit?.snippet).toContain("读书笔记");
    });
  });

  it("ranks a tag hit above a body-only match — boost 2 over 1", async () => {
    await withWorkspace(async (dir) => {
      // The rare term sits in b's body but only in a's tags; boost decides the order.
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await writeTextAt(join(dir, "b.html"), DOC("b", "罕见词 出现一次"));
      await tag(dir, "a.html", ["罕见词"]);

      const result = await find(dir, "罕见词");

      expect(result.results.map((hit) => hit.path)).toEqual(["a.html", "b.html"]);
      expect(result.results[0]?.tags).toEqual(["罕见词"]);
      expect(result.results[1]?.tags).toEqual([]);
    });
  });

  it("answers [] tags on a hit whose doc has no metadata", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      const result = await find(dir, "苹果");
      expect(result.results[0]?.tags).toEqual([]);
    });
  });
});

describe("search · meta freshness", () => {
  it("a tag edit re-indexes only that doc — the sibling is never re-read", async () => {
    await withWorkspace(async (dir) => {
      const workspaceReal = await nodePatchDeps.fs.realpath(dir);
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await writeTextAt(join(dir, "b.html"), DOC("b", "钢铁 冶炼"));
      await find(dir, "苹果");

      const seen: string[] = [];
      await tag(dir, "a.html", ["园艺"]);
      const result = await find(dir, "园艺", countingDeps(seen));

      expect(result.results[0]?.path).toBe("a.html");
      expect(result.results[0]?.tags).toEqual(["园艺"]);
      const docReads = docReadsOf(seen, workspaceReal);
      expect(docReads.length).toBeGreaterThan(0);
      for (const read of docReads) expect(read.endsWith("a.html")).toBe(true);
      expect(seen.some((path) => path.endsWith("b.html"))).toBe(false);
    });
  });

  it("a removed tag stops matching on the next search without a doc rewrite", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await tag(dir, "a.html", ["园艺", "果树"]);
      expect((await find(dir, "园艺")).results[0]?.path).toBe("a.html");

      await tag(dir, "a.html", ["果树"]);
      expect((await find(dir, "园艺")).results).toEqual([]);
      expect((await find(dir, "果树")).results[0]?.path).toBe("a.html");
      expect((await find(dir, "苹果")).results[0]?.tags).toEqual(["果树"]);
    });
  });

  it("persists the meta fingerprint so an unchanged tag set writes nothing", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await tag(dir, "a.html", ["园艺"]);
      await find(dir, "园艺");
      const indexPath = join(dir, INDEX);
      const mtime = (await stat(indexPath)).mtimeMs;

      // Rewriting the identical tag list is a no-op write — the index must stay put too.
      await tag(dir, "a.html", ["园艺"]);
      await find(dir, "园艺");
      expect((await stat(indexPath)).mtimeMs).toBe(mtime);
    });
  });

  it("a corrupt meta table reports its diagnostic while docs still answer", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await mkdir(join(dir, ".hreader"), { recursive: true });
      await writeFile(join(dir, ".hreader", "meta.json"), "{broken", "utf8");

      const result = await find(dir, "苹果");

      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics.some((line) => line.includes("doc_meta_corrupt"))).toBe(true);
    });
  });

  it("a crafted tags-field hit without a stored tags string snippets as empty", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "real.html"), DOC("r", "苹果 种植"));
      // `tags` indexed but never stored → the snippet source falls back to "".
      const mini = new MiniSearch<Record<string, unknown>>({
        fields: ["tags"],
        storeFields: ["path", "kind"],
      });
      mini.addAll([{ id: "doc\u0000g9.html", kind: "doc", path: "g9.html", tags: "孤立标签词" }]);
      await mkdir(join(dir, ".hreader", "index"), { recursive: true });
      await writeFile(
        join(dir, INDEX),
        JSON.stringify({ version: 4, docs: {}, index: mini.toJSON() }),
        "utf8",
      );

      const result = await find(dir, "孤立标签词");

      expect(result.results[0]?.kind).toBe("doc");
      expect(result.results[0]?.snippet).toBe("");
    });
  });

  it("a failed meta-table read keeps the old fingerprint so the next query retries", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await find(dir, "苹果");
      await tag(dir, "a.html", ["园艺"]);
      const result = await find(dir, "苹果", metaBlindDeps);
      expect(result.results[0]?.path).toBe("a.html");
      // The stale meta entry stayed; the healthy retry picks the tag up.
      expect((await find(dir, "园艺")).results[0]?.path).toBe("a.html");
    });
  });

  it("keeps indexed tags when the doc re-indexes inside a meta-table outage", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await tag(dir, "a.html", ["园艺"]);
      await find(dir, "园艺");
      const indexPath = join(dir, INDEX);
      const metaBefore = (
        JSON.parse(await readFile(indexPath, "utf8")) as { docs: Record<string, { meta: string }> }
      ).docs["a.html"]?.meta;

      // The table goes unreadable while the doc bytes move — this re-index lands inside
      // the outage and must not drop the tag field.
      await writeTextAt(join(dir, "a.html"), DOC("a", "水稻 收割"));
      const blind = await find(dir, "水稻", metaBlindDeps);
      expect(blind.results[0]?.path).toBe("a.html");
      expect(blind.results[0]?.tags).toEqual(["园艺"]);

      // The held fingerprint is still the stored one, so recovery needs no doc rewrite and
      // the tags answer again.
      const metaAfter = (
        JSON.parse(await readFile(indexPath, "utf8")) as { docs: Record<string, { meta: string }> }
      ).docs["a.html"]?.meta;
      expect(metaAfter).toBe(metaBefore);
      const healed = await find(dir, "园艺");
      expect(healed.results[0]?.path).toBe("a.html");
      expect(healed.results[0]?.tags).toEqual(["园艺"]);
    });
  });

  it("indexes the rewritten tags when the table changed during the outage", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await tag(dir, "a.html", ["园艺"]);
      await find(dir, "园艺");

      await writeTextAt(join(dir, "a.html"), DOC("a", "水稻 收割"));
      const blind = await find(dir, "水稻", metaBlindDeps);
      expect(blind.results[0]?.path).toBe("a.html");
      expect(blind.results[0]?.tags).toEqual(["园艺"]);

      // The tag list moved while the index was blind: the held fingerprint differs, so the
      // healthy read re-indexes once more and the NEW tags answer.
      await tag(dir, "a.html", ["冶金"]);
      const healed = await find(dir, "冶金");
      expect(healed.results[0]?.path).toBe("a.html");
      expect(healed.results[0]?.tags).toEqual(["冶金"]);
      expect((await find(dir, "园艺")).results).toEqual([]);
    });
  });

  it("indexes a doc first seen during a meta-table outage once the table reads", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await tag(dir, "a.html", ["园艺"]);

      // No prior record: there is no indexed tag list to hold, so the doc indexes bare.
      const blind = await find(dir, "苹果", metaBlindDeps);
      expect(blind.results[0]?.path).toBe("a.html");
      expect(blind.results[0]?.tags).toEqual([]);

      const healed = await find(dir, "园艺");
      expect(healed.results[0]?.path).toBe("a.html");
      expect(healed.results[0]?.tags).toEqual(["园艺"]);
    });
  });

  it("indexes tags on docs named __proto__.html, constructor.html and prototype.html", async () => {
    await withWorkspace(async (dir) => {
      const files = ["__proto__.html", "constructor.html", "prototype.html"];
      for (const [index, file] of files.entries()) {
        await writeTextAt(join(dir, file), DOC(`d${String(index)}`, "苹果 种植"));
        await tag(dir, file, [`tag-${String(index)}`]);
      }

      for (const [index, file] of files.entries()) {
        const result = await find(dir, `tag-${String(index)}`);
        expect(result.results[0]?.path).toBe(file);
        expect(result.results[0]?.tags).toEqual([`tag-${String(index)}`]);
      }
    });
  });

  it("keeps every doc's tags searchable after a doc named constructor carries meta", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await writeTextAt(join(dir, "constructor"), "x");
      await tag(dir, "a.html", ["园艺"]);
      expect((await find(dir, "园艺")).results[0]?.path).toBe("a.html");

      // The write itself reports success; the regression was the READ side rejecting the
      // stored "constructor" key as dangerous and emptying the whole table.
      const written = await setDocMeta(
        { workspace: dir, file: "constructor", patch: { tags: ["构"] }, by: "user" },
        nodePatchDeps,
      );
      expect(written.changed).toBe(true);

      const result = await find(dir, "园艺");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.results[0]?.tags).toEqual(["园艺"]);
      expect(
        (await getDocMeta({ workspace: dir, file: "constructor" }, nodePatchDeps)).meta.tags,
      ).toEqual(["构"]);
    });
  });

  it("a v3 index rebuilds once into v4 and then stays quiet", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "苹果 种植"));
      await tag(dir, "a.html", ["园艺"]);
      await find(dir, "园艺");
      const indexPath = join(dir, INDEX);
      const parsed = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
      parsed["version"] = 3;
      await writeTextAt(indexPath, JSON.stringify(parsed));

      const rebuilt = await find(dir, "园艺");
      expect(rebuilt.results[0]?.path).toBe("a.html");
      expect(rebuilt.diagnostics.some((line) => line.includes("重建"))).toBe(true);
      expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({ version: 4 });

      const mtime = (await stat(indexPath)).mtimeMs;
      const again = await find(dir, "园艺");
      expect(again.diagnostics).toEqual([]);
      expect((await stat(indexPath)).mtimeMs).toBe(mtime);
    });
  });
});
