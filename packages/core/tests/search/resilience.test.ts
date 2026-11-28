// Degraded paths of the search index: every IO failure degrades to one code-only diagnostic
// (never an absolute path, never a crash), the answer still comes back from the freshest
// state available, and malformed stored fields fall back to "" — verified against wrapped
// fs errors and a hand-crafted index file.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import MiniSearch from "minisearch";
import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import type { FileSystem, PatchDeps } from "../../src/io/ports";
import { addSidecarAnnotation } from "../../src/ops/sidecar-ops";
import { searchLibrary } from "../../src/search";
import { newSearchBucket, pushSearchDiagnostic } from "../../src/search/index-store";
import { writeTextAt, withWorkspace } from "../io/harness";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

const INDEX = join(".hreader", "index", "search.json");

const find = (dir: string, query: string, deps = nodePatchDeps) =>
  searchLibrary({ workspace: dir, query }, deps);

/** Deps with a subset of fs methods swapped out; everything else passes through to node-fs. */
const failingDeps = (wrap: Partial<FileSystem>): PatchDeps => ({
  ...nodePatchDeps,
  fs: { ...nodePatchDeps.fs, ...wrap },
});

const failOn = (
  method: "readFile" | "readdir" | "lstat" | "realpath",
  select: (path: string) => boolean,
  error: () => Error,
): Partial<FileSystem> => {
  const impl = async (path: string) => {
    if (select(path)) throw error();
    return await (nodePatchDeps.fs[method] as (p: string) => Promise<unknown>)(path);
  };
  const partial: Partial<FileSystem> = { [method]: impl };
  return partial;
};

const ioError = (code: string): Error => Object.assign(new Error(code), { code });

const seedAnnotation = (dir: string, file: string): Promise<unknown> =>
  addSidecarAnnotation(
    {
      workspace: dir,
      file,
      selector: "body > p:nth-of-type(1)",
      anchor: { exact: "摩托", prefix: "", suffix: "", start: 0 },
      note: "侧车记录",
      author: "user",
    },
    nodePatchDeps,
  );

describe("search resilience", () => {
  it("an unreadable directory is one diagnostic, and the rest of the walk proceeds", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await mkdir(join(dir, "locked"));
      const deps = failingDeps(
        failOn(
          "readdir",
          (path) => path.endsWith("locked"),
          () => ioError("EACCES"),
        ),
      );
      const result = await find(dir, "摩托", deps);
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics.some((line) => line.includes("目录不可读"))).toBe(true);
      expect(JSON.stringify(result.diagnostics)).not.toContain(dir);
    });
  });

  it("an unstatable entry is one diagnostic and stays out of the index", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await writeTextAt(join(dir, "ghost.html"), DOC("g", "摩托"));
      const deps = failingDeps(
        failOn(
          "lstat",
          (path) => path.endsWith("ghost.html"),
          () => ioError("EIO"),
        ),
      );
      const result = await find(dir, "摩托", deps);
      expect(result.results.map((hit) => hit.path)).toEqual(["a.html"]);
      expect(result.diagnostics.some((line) => line.includes("条目不可读"))).toBe(true);
    });
  });

  it("an unreadable index file rebuilds with a diagnostic, not a crash", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      const deps = failingDeps(
        failOn(
          "readFile",
          (path) => path.endsWith("search.json"),
          () => ioError("EACCES"),
        ),
      );
      const result = await find(dir, "摩托", deps);
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics.some((line) => line.includes("搜索索引不可读"))).toBe(true);
    });
  });

  it("a non-object index file rebuilds the same way", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await mkdir(join(dir, ".hreader", "index"), { recursive: true });
      await writeFile(join(dir, INDEX), "null", "utf8");
      const result = await find(dir, "摩托");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toContain("重建");
    });
  });

  it("a malformed MiniSearch payload rebuilds the same way", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await mkdir(join(dir, ".hreader", "index"), { recursive: true });
      await writeFile(
        join(dir, INDEX),
        JSON.stringify({ version: 4, docs: {}, index: { bogus: true } }),
        "utf8",
      );
      const result = await find(dir, "摩托");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics).toHaveLength(1);
    });
  });

  it("malformed per-doc records are skipped instead of crashing the load", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      const mini = new MiniSearch<{ id: string }>({ fields: ["title"] });
      await mkdir(join(dir, ".hreader", "index"), { recursive: true });
      await writeFile(
        join(dir, INDEX),
        JSON.stringify({
          version: 4,
          docs: {
            "s.html": "garbage",
            "t.html": { mtimeMs: "x", size: 1, sha: "s", sidecar: null },
            "u.html": { mtimeMs: 1, size: "x", sha: "s", sidecar: null },
            "v.html": { mtimeMs: 1, size: 1, sha: 5, sidecar: null },
            "w.html": null,
            "x.html": 42,
            "y.html": { mtimeMs: 1, size: 1, sha: "s", sidecar: "bogus" },
            "z.html": { mtimeMs: 1, size: 1, sha: "s", sidecar: { mtimeMs: "x", size: 1 } },
            "zz.html": { mtimeMs: 1, size: 1, sha: "s", sidecar: { mtimeMs: 1, size: "x" } },
            "m1.html": { mtimeMs: 1, size: 1, sha: "s", sidecar: null, meta: 5 },
            "m2.html": { mtimeMs: 1, size: 1, sha: "s", sidecar: null, meta: {} },
          },
          index: mini.toJSON(),
        }),
        "utf8",
      );
      const result = await find(dir, "摩托");
      expect(result.results[0]?.path).toBe("a.html");
    });
  });

  it("an unreadable doc reports a diagnostic — fs code, or 'internal' for a bare error", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await writeTextAt(join(dir, "sick.html"), DOC("sick", "别的"));
      await writeTextAt(join(dir, "bare.html"), DOC("bare", "其他"));
      // `sick` carries an fs code, `bare` carries nothing — the diagnostic falls to "internal".
      const split = failingDeps({
        readFile: async (path) => {
          if (path.endsWith("sick.html")) throw ioError("EACCES");
          if (path.endsWith("bare.html")) throw new TypeError("no code");
          return await nodePatchDeps.fs.readFile(path);
        },
      });
      const result = await find(dir, "摩托", split);
      expect(result.results.map((hit) => hit.path)).toEqual(["a.html"]);
      expect(result.diagnostics.some((line) => line.includes("EACCES"))).toBe(true);
      expect(result.diagnostics.some((line) => line.includes("internal"))).toBe(true);
    });
  });

  it("a doc that fails between stat and read keeps its previous index entry", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await find(dir, "摩托");
      // Fresh mtime forces a re-read; the read then fails — the stale record must survive.
      const future = new Date(Date.now() + 10_000);
      await utimes(join(dir, "a.html"), future, future);
      const deps = failingDeps(
        failOn(
          "readFile",
          (path) => path.endsWith("a.html"),
          () => ioError("EACCES"),
        ),
      );
      const result = await find(dir, "摩托", deps);
      expect(result.diagnostics.some((line) => line.includes("a.html"))).toBe(true);
      // The stored index still answers — the doc's text is unchanged since indexing.
      expect(result.results[0]?.path).toBe("a.html");
    });
  });

  it("an mtime-only touch re-reads the bytes but keeps the index entry", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await find(dir, "摩托");
      const future = new Date(Date.now() + 10_000);
      await utimes(join(dir, "a.html"), future, future);
      const result = await find(dir, "摩托");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics).toEqual([]);
    });
  });

  it("a doc that is not valid UTF-8 reports its code and skips the entry", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await writeFile(join(dir, "bad.html"), Buffer.from([0xff, 0xfe, 0x41, 0x42]));
      const result = await find(dir, "摩托");
      expect(result.results.map((hit) => hit.path)).toEqual(["a.html"]);
      expect(result.diagnostics.some((line) => line.includes("bad.html"))).toBe(true);
      expect(result.diagnostics.some((line) => line.includes("invalid_utf8"))).toBe(true);
    });
  });

  it("a doc that turns invalid after indexing keeps its previous entry + diagnostic", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await find(dir, "摩托");
      // Overwrite with invalid UTF-8: the re-extract fails and the old record survives.
      await writeFile(join(dir, "a.html"), Buffer.from([0xff, 0xfe, 0x41, 0x42]));
      const result = await find(dir, "摩托");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics.some((line) => line.includes("invalid_utf8"))).toBe(true);
    });
  });

  it("non-HTML files are never indexed", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await writeTextAt(join(dir, "notes.txt"), "摩托");
      const result = await find(dir, "摩托");
      expect(result.results.map((hit) => hit.path)).toEqual(["a.html"]);
    });
  });

  it("a sidecar read failure keeps the doc and reports the annotation diagnostic", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await seedAnnotation(dir, "a.html");
      const deps = failingDeps(
        failOn(
          "readFile",
          (path) => path.includes(join(".hreader", "annotations")),
          () => ioError("EACCES"),
        ),
      );
      const result = await find(dir, "摩托", deps);
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics.some((line) => line.includes("批注"))).toBe(true);
    });
  });

  it("a corrupt sidecar file flows into diagnostics while the doc still indexes", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await seedAnnotation(dir, "a.html");
      const sidecar = join(
        dir,
        ".hreader",
        "annotations",
        `${createHash("sha1").update("a.html").digest("hex")}.json`,
      );
      await writeFile(sidecar, "{ not json", "utf8");
      const result = await find(dir, "摩托");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  });

  it("an unwritable index directory still answers from the fresh in-memory index", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      // `.hreader/index` is a regular file: mkdir and the atomic write both fail.
      await mkdir(join(dir, ".hreader"), { recursive: true });
      await writeFile(join(dir, ".hreader", "index"), "x", "utf8");
      const result = await find(dir, "摩托");
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics.some((line) => line.includes("搜索索引写入失败"))).toBe(true);
    });
  });

  it("folds diagnostics past the cap into one trailing summary line", async () => {
    await withWorkspace(async (dir) => {
      for (let i = 0; i < 105; i += 1) {
        await writeTextAt(join(dir, `f${String(i)}.html`), DOC(String(i), "别的"));
      }
      const deps = failingDeps(
        failOn(
          "readFile",
          (path) => path.endsWith(".html"),
          () => ioError("EACCES"),
        ),
      );
      const result = await find(dir, "摩托", deps);
      expect(result.diagnostics).toHaveLength(101);
      expect(result.diagnostics[100]).toContain("条诊断已省略");
    });
  });

  it("walks into ordinary subdirectories", async () => {
    await withWorkspace(async (dir) => {
      await mkdir(join(dir, "sub"));
      await writeTextAt(join(dir, "sub", "inner.html"), DOC("i", "摩托 手册"));
      const result = await find(dir, "摩托");
      expect(result.results[0]?.path).toBe("sub/inner.html");
    });
  });

  it("a hit whose snippet source cannot be read degrades to an empty snippet + diagnostic", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "e.html"), DOC("e", "独特词甲 正文"));
      await find(dir, "独特词甲");
      // mtime/size unchanged → the update never re-reads; the snippet's resolveTarget then
      // fails — `realpath` errors land as `io_failure` (HrError wrapping happens inside).
      const deps = failingDeps(
        failOn(
          "realpath",
          (path) => path.endsWith("e.html"),
          () => ioError("EACCES"),
        ),
      );
      const result = await find(dir, "独特词甲", deps);
      expect(result.results[0]?.path).toBe("e.html");
      expect(result.results[0]?.snippet).toBe("");
      expect(result.diagnostics.some((line) => line.includes("io_failure"))).toBe(true);
    });
  });

  it("elides nothing when a workspace root is the filesystem root", () => {
    const bucket = newSearchBucket("/", "/");
    pushSearchDiagnostic(bucket, "文档 a.html：ENOENT");
    expect(bucket.diagnostics).toEqual(["文档 a.html：ENOENT"]);
    // Even a "/" inside the message survives: the root itself is never treated as a prefix.
    pushSearchDiagnostic(bucket, "见 /a//b/");
    expect(bucket.diagnostics[1]).toBe("见 /a//b/");
  });

  it("elides the longer root first when lexical and real roots nest", () => {
    // "/aa" would strip "/aa/bb" down to "bb/…" if it ran first; longest-first keeps "f.html".
    const bucket = newSearchBucket("/aa", "/aa/bb");
    pushSearchDiagnostic(bucket, "读取 /aa/bb/f.html 失败");
    expect(bucket.diagnostics).toEqual(["读取 f.html 失败"]);
  });

  it("reports an empty-string error code as internal", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      await writeTextAt(join(dir, "b.html"), DOC("b", "别的"));
      const deps = failingDeps(
        failOn(
          "readFile",
          (path) => path.endsWith("b.html"),
          () => ioError(""),
        ),
      );
      const result = await find(dir, "摩托", deps);
      expect(result.results.map((hit) => hit.path)).toEqual(["a.html"]);
      expect(result.diagnostics.some((line) => line.endsWith("internal"))).toBe(true);
    });
  });

  it("heals the index file after every corrupt variant — even with an empty library", async () => {
    await withWorkspace(async (dir) => {
      await mkdir(join(dir, ".hreader", "index"), { recursive: true });
      const indexPath = join(dir, INDEX);
      // Missing file: the first run still writes a fresh index.
      await find(dir, "摩托");
      expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({ version: 4 });
      for (const blob of [
        "{ not the index",
        "null",
        JSON.stringify({ version: 4, docs: {}, index: {} }),
        JSON.stringify({
          version: 1,
          docs: {},
          index: new MiniSearch<{ id: string }>({ fields: ["title"] }).toJSON(),
        }),
        JSON.stringify({ version: 4, docs: {}, index: { bogus: true } }),
      ]) {
        await writeFile(indexPath, blob, "utf8");
        await find(dir, "摩托");
        // `rebuilt` is what forces the write — a healed file must carry the envelope again.
        expect(JSON.parse(await readFile(indexPath, "utf8"))).toMatchObject({ version: 4 });
      }
    });
  });

  it("a docs record that is not an object rebuilds instead of iterating it", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "摩托 手册"));
      const mini = new MiniSearch<{ id: string }>({ fields: ["title"] });
      await mkdir(join(dir, ".hreader", "index"), { recursive: true });
      for (const docs of [null, 42]) {
        await writeFile(
          join(dir, INDEX),
          JSON.stringify({ version: 4, docs, index: mini.toJSON() }),
          "utf8",
        );
        const result = await find(dir, "摩托");
        expect(result.results[0]?.path).toBe("a.html");
        expect(result.diagnostics.some((line) => line.includes("重建"))).toBe(true);
      }
    });
  });

  it("a same-mtime size change still re-indexes the doc", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, "a.html");
      await writeTextAt(file, DOC("a", "旧词 手册"));
      await find(dir, "旧词");
      const before = await stat(file);
      // Same mtime, different size: the size guard is the only thing that re-reads this doc.
      await writeTextAt(file, DOC("a", "新词较长替换文本 手册"));
      await utimes(file, before.atime, before.mtime);
      const result = await find(dir, "新词较长替换文本");
      expect(result.results[0]?.path).toBe("a.html");
    });
  });

  it("a same-content touch persists the new mtime into the stored record", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, "a.html");
      await writeTextAt(file, DOC("a", "摩托 手册"));
      await find(dir, "摩托");
      const future = new Date(Date.now() + 10_000);
      await utimes(file, future, future);
      await find(dir, "摩托");
      const stored = JSON.parse(await readFile(join(dir, INDEX), "utf8")) as {
        docs: Record<string, { mtimeMs: number }>;
      };
      // fs mtime precision varies; the new record must sit near the touched timestamp.
      expect(Math.abs((stored.docs["a.html"]?.mtimeMs ?? 0) - future.getTime())).toBeLessThan(1000);
    });
  });

  it("a same-content touch does not re-list the doc's annotations", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, "a.html");
      await writeTextAt(file, DOC("a", "摩托 手册"));
      await seedAnnotation(dir, "a.html");
      await find(dir, "摩托");
      const future = new Date(Date.now() + 10_000);
      await utimes(file, future, future);
      // sha matches → the fast path skips re-extracting AND re-listing; a sidecar read that
      // now fails must produce no diagnostic at all.
      const deps = failingDeps(
        failOn(
          "readFile",
          (path) => path.includes(join(".hreader", "annotations")),
          () => ioError("EACCES"),
        ),
      );
      const result = await find(dir, "摩托", deps);
      expect(result.results[0]?.path).toBe("a.html");
      expect(result.diagnostics).toEqual([]);
    });
  });

  it("a workspace that does not exist fails instead of answering", async () => {
    await expect(find(join("/nonexistent", "hr-search-nope"), "摩托")).rejects.toMatchObject({
      code: "not_a_file",
    });
    await expect(find(join("/nonexistent", "hr-search-nope"), "摩托")).rejects.toThrow(/realpath/u);
  });
});

describe("search hits from a crafted index", () => {
  it("stored-field gaps fall back to empty strings on the wire", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "real.html"), DOC("r", "摩托 手册"));
      // An index shaped like ours, with entries the writer never produces: a path-less doc,
      // a title-less doc whose file vanished, and an annotation entry with no stored text.
      const mini = new MiniSearch<Record<string, unknown>>({
        fields: ["title", "headings", "body", "annotation"],
        storeFields: ["path", "kind", "title", "docTitle", "annotationId", "annotation"],
      });
      mini.addAll([
        { id: "doc\u0000g2.html", kind: "doc", body: "orphanterma" },
        { id: "doc\u0000g3.html", path: "g3.html", kind: "doc", body: "orphantermb" },
        {
          id: "an\u0000g3.html\u0000an-a1",
          path: "g3.html",
          kind: "annotation",
          title: "orphantermc",
          annotationId: "an-a1",
        },
      ]);
      await mkdir(join(dir, ".hreader", "index"), { recursive: true });
      await writeFile(
        join(dir, INDEX),
        JSON.stringify({ version: 4, docs: {}, index: mini.toJSON() }),
        "utf8",
      );

      // Path-less entry: `path` is not a string → "" on the wire; resolving "" then fails
      // into one diagnostic instead of a crash — and the diagnostic names "".
      const noPath = await find(dir, "orphanterma");
      expect(noPath.results[0]?.path).toBe("");
      expect(noPath.results[0]?.title).toBe("");
      expect(noPath.results[0]?.snippet).toBe("");
      expect(noPath.diagnostics.some((line) => line.includes("文档 ："))).toBe(true);

      // Title-less entry on a vanished file: `title`/`docTitle` missing → "".
      const noTitle = await find(dir, "orphantermb");
      expect(noTitle.results[0]?.title).toBe("");
      expect(noTitle.diagnostics.some((line) => line.includes("g3.html"))).toBe(true);

      // Annotation entry without stored `annotation`: snippet source is "".
      const noAnno = await find(dir, "orphantermc");
      const anno = noAnno.results[0];
      expect(anno?.kind).toBe("annotation");
      expect(anno?.annotationId).toBe("an-a1");
      expect(anno?.snippet).toBe("");
    });
  });

  it("a headings-only match snippets from the headings field", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(
        join(dir, "a.html"),
        `<!doctype html><html><head><title>普通文档</title></head><body><h2>僻字璩玉查询</h2><p>无关</p></body></html>`,
      );
      const result = await find(dir, "璩玉");
      const hit = result.results[0];
      expect(hit?.path).toBe("a.html");
      expect(hit?.snippet).toContain("璩玉");
    });
  });

  it("drops mistyped stored fields instead of echoing them onto the wire", async () => {
    await withWorkspace(async (dir) => {
      const mini = new MiniSearch<Record<string, unknown>>({
        fields: ["title", "headings", "body", "annotation"],
        storeFields: ["path", "kind", "title", "docTitle", "annotationId", "annotation"],
      });
      mini.addAll([
        // A doc entry must never surface an annotationId, even a stored one.
        {
          id: "doc\u0000d.html",
          path: "d.html",
          kind: "doc",
          body: "ghostterm",
          annotationId: "x",
        },
        // Non-string annotationId on an annotation hit stays off the wire.
        {
          id: "an\u0000d.html\u0000a1",
          path: "d.html",
          kind: "annotation",
          annotation: "ghostterm",
          annotationId: 42,
          title: 9,
          docTitle: 8,
        },
      ]);
      await mkdir(join(dir, ".hreader", "index"), { recursive: true });
      await writeFile(
        join(dir, INDEX),
        JSON.stringify({ version: 4, docs: {}, index: mini.toJSON() }),
        "utf8",
      );

      const result = await find(dir, "ghostterm");
      const docHit = result.results.find((hit) => hit.kind === "doc");
      expect(docHit).not.toHaveProperty("annotationId");
      const annoHit = result.results.find((hit) => hit.kind === "annotation");
      expect(annoHit).not.toHaveProperty("annotationId");
      // title and docTitle are both non-strings → the wire title is "".
      expect(annoHit?.title).toBe("");
    });
  });
});
