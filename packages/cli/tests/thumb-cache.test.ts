// This layer covers the `.hreader/thumbs` cache contract on a real temp dir
// (the fs port over node, an injected clock for LRU order, a tiny injected
// limit so eviction needs no 500 MB fixtures): hit/miss, content-keyed
// regeneration, PNG-signature rejection, and least-recently-hit eviction.

import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { nodePatchDeps, type PatchDeps } from "@hreader/core";

import { createThumbCache, type ThumbCache } from "../src/thumbs/cache";
import { pngOf } from "./chrome-png";

const dir = mkdtempSync(join(tmpdir(), "hr-thumb-cache-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

/** Deterministic LRU order: each injection advances the clock so "least recently hit" is a choice, never an accident. */
const clockOf = (): PatchDeps["clock"] => {
  let now = 1_000;
  return {
    now: () => {
      now += 1;
      return new Date(now);
    },
  };
};

const depsOf = (): PatchDeps => ({ ...nodePatchDeps, clock: clockOf() });

const cacheOf = (sub: string, limitBytes?: number): ThumbCache =>
  createThumbCache({
    dir: join(dir, sub, ".hreader", "thumbs"),
    deps: depsOf(),
    ...(limitBytes === undefined ? {} : { limitBytes }),
  });

const storeFile = (cacheDir: string, hash: string, bytes: Uint8Array): string => {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, `${hash}.png`);
  writeFileSync(path, bytes);
  return path;
};

describe("thumbs/cache · get/put", () => {
  it("should miss on an empty cache, then hit after put", async () => {
    const cache = cacheOf("basic");
    const png = pngOf(600, 400);

    expect(await cache.get(HASH_A)).toBeUndefined();
    await cache.put(HASH_A, png);
    expect(await cache.get(HASH_A)).toEqual(Buffer.from(png));
  });

  it("should key entries by content hash, never by document path", async () => {
    const cache = cacheOf("keyed");
    const first = pngOf(600, 400);
    const second = pngOf(2, 2);

    await cache.put(HASH_A, first);
    // A different document with different bytes has a different hash: no hit, no overwrite.
    expect(await cache.get(HASH_B)).toBeUndefined();
    await cache.put(HASH_B, second);
    expect(await cache.get(HASH_A)).toEqual(Buffer.from(first));
    expect(await cache.get(HASH_B)).toEqual(Buffer.from(second));
  });
});

describe("thumbs/cache · corrupt entries", () => {
  it("should treat a corrupt cached file as a miss and unlink it", async () => {
    const cacheDir = join(dir, "corrupt", ".hreader", "thumbs");
    const cache = cacheOf("corrupt");
    const path = storeFile(cacheDir, HASH_A, Buffer.from("GIF89a not a png"));

    expect(await cache.get(HASH_A)).toBeUndefined();
    // The bad file must not linger: the next read is a miss too, not a second corruption report.
    expect(await cache.get(HASH_A)).toBeUndefined();
    expect(() => readFileSync(path)).toThrow();
  });

  it("should treat a PNG-signature-valid but truncated file as a miss", async () => {
    const cacheDir = join(dir, "truncated", ".hreader", "thumbs");
    const cache = cacheOf("truncated");
    storeFile(cacheDir, HASH_A, pngOf(600, 400).subarray(0, 8));

    expect(await cache.get(HASH_A)).toBeUndefined();
  });
});

describe("thumbs/cache · hash key validation", () => {
  it("should refuse a non-sha256-hex key instead of letting it name a path", async () => {
    const cache = cacheOf("badkey");
    await expect(cache.get("../escape")).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("sha256") as string,
    });
    await expect(cache.put("Z".repeat(64), pngOf(1, 1))).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("sha256") as string,
    });
  });

  it("should anchor the hash regex: hex with a junk prefix or suffix is still not a key", async () => {
    const cache = cacheOf("anchors");
    await expect(cache.get(`z${HASH_A}`)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(cache.get(`${HASH_A}z`)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(cache.get(`z${HASH_A}z`)).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("thumbs/cache · LRU eviction", () => {
  it("should evict the least recently hit entries once the limit is exceeded", async () => {
    // Entries are ~33 bytes each: a 100-byte limit holds at most 3.
    const cache = cacheOf("evict", 100);
    const cacheDir = join(dir, "evict", ".hreader", "thumbs");
    await cache.put(HASH_A, pngOf(1, 1));
    await cache.put(HASH_B, pngOf(2, 2));
    await cache.put(HASH_C, pngOf(3, 3));
    // HASH_A is oldest-hit; the fourth put must evict it, not the fresh entries.
    await cache.put(HASH_D, pngOf(4, 4));

    expect(await cache.get(HASH_A)).toBeUndefined();
    expect(await cache.get(HASH_B)).toEqual(Buffer.from(pngOf(2, 2)));
    expect(await cache.get(HASH_C)).toEqual(Buffer.from(pngOf(3, 3)));
    expect(await cache.get(HASH_D)).toEqual(Buffer.from(pngOf(4, 4)));
    // The evicted row leaves the index too — a stale row would poison later reads.
    expect([...indexEntriesOf(cacheDir)].sort()).toEqual([HASH_B, HASH_C, HASH_D]);
  });

  it("should stop evicting as soon as the total fits — an exact-fit tail keeps its entries", async () => {
    // Four same-size entries; limit = exactly three sizes. One eviction lands the
    // total precisely on the limit: `<=` stops there, a `<` would over-evict.
    const entry = pngOf(1, 1);
    const cache = cacheOf("exact-fit", entry.length * 3);
    await cache.put(HASH_A, entry);
    await cache.put(HASH_B, entry);
    await cache.put(HASH_C, entry);
    await cache.put(HASH_D, entry);

    expect(await cache.get(HASH_A)).toBeUndefined();
    expect(await cache.get(HASH_B)).toEqual(Buffer.from(entry));
    expect(await cache.get(HASH_C)).toEqual(Buffer.from(entry));
    expect(await cache.get(HASH_D)).toEqual(Buffer.from(entry));
  });

  it("should let a hit rescue an entry from eviction (at order, not insertion order)", async () => {
    const cache = cacheOf("rescue", 100);
    await cache.put(HASH_A, pngOf(1, 1));
    await cache.put(HASH_B, pngOf(2, 2));
    await cache.put(HASH_C, pngOf(3, 3));
    // Hit HASH_A: now HASH_B is the least recently hit despite being newer than A.
    expect(await cache.get(HASH_A)).toBeDefined();
    await cache.put(HASH_D, pngOf(4, 4));

    expect(await cache.get(HASH_A)).toBeDefined();
    expect(await cache.get(HASH_B)).toBeUndefined();
  });

  it("should never evict the entry it just wrote, even when it alone exceeds the limit", async () => {
    const cache = cacheOf("oversized", 10);
    await cache.put(HASH_A, pngOf(600, 400));

    expect(await cache.get(HASH_A)).toEqual(Buffer.from(pngOf(600, 400)));
  });
});

describe("thumbs/cache · index rebuild", () => {
  it("should drop index rows whose PNG vanished and adopt stray PNGs on disk", async () => {
    const cacheDir = join(dir, "rebuild", ".hreader", "thumbs");
    const cache = cacheOf("rebuild");
    await cache.put(HASH_A, pngOf(1, 1));
    // Behind the cache's back: remove one PNG, drop a stranger in.
    rmSync(join(cacheDir, `${HASH_A}.png`));
    writeFileSync(join(cacheDir, `${HASH_B}.png`), pngOf(2, 2));

    expect(await cache.get(HASH_A)).toBeUndefined();
    expect(await cache.get(HASH_B)).toEqual(Buffer.from(pngOf(2, 2)));
    // The adoption is a real index row: hash key plus a numeric at/size from lstat — anything less poisons eviction.
    const entries = indexEntryMapOf(cacheDir);
    expect(Object.keys(entries).sort()).toEqual([HASH_B]);
    expect(entries[HASH_B]).toMatchObject({
      at: expect.any(Number) as number,
      size: pngOf(2, 2).length,
    });
  });

  it("should rebuild from the directory when index.json is corrupt", async () => {
    const cacheDir = join(dir, "badindex", ".hreader", "thumbs");
    const cache = cacheOf("badindex");
    await cache.put(HASH_A, pngOf(1, 1));
    writeFileSync(join(cacheDir, "index.json"), "not json {{{");

    expect(await cache.get(HASH_A)).toEqual(Buffer.from(pngOf(1, 1)));
  });

  it.each([
    ["a non-object payload", "5"],
    ["a null payload", "null"],
    ["an array payload", "[1]"],
    ["a foreign version", '{"version":2,"entries":{}}'],
    ["non-object entries", '{"version":1,"entries":5}'],
    ["null entries", '{"version":1,"entries":null}'],
    [
      "junk entry rows",
      // D and F have real PNGs on disk: their malformed rows must be dropped and
      // the files re-adopted with lstat-derived at/size — not kept as written.
      `{"version":1,"entries":{"zzz":{"at":1,"size":1},"${HASH_A}":{"at":1,"size":1},"${HASH_B}":null,"${HASH_C}":7,"${HASH_D}":{"at":1,"size":"x"},"${HASH_F}":{"at":"x","size":1}}}`,
    ],
  ])(
    "should rebuild the index from the directory when index.json holds %s",
    async (label, text) => {
      const sub = `badindex-${label.length.toString()}-${text.length.toString()}`;
      const cacheDir = join(dir, sub, ".hreader", "thumbs");
      const cache = cacheOf(sub);
      await cache.put(HASH_E, pngOf(5, 5));
      storeFile(cacheDir, HASH_D, pngOf(6, 6));
      storeFile(cacheDir, HASH_F, pngOf(7, 7));
      writeFileSync(join(cacheDir, "index.json"), text);

      // Every malformed row drops out; the PNGs on disk are re-adopted by mtime.
      expect(await cache.get(HASH_E)).toEqual(Buffer.from(pngOf(5, 5)));
      // The rebuilt index on disk carries only the PNGs that exist: junk rows,
      // and even a well-formed row for an absent PNG (A), must not survive.
      const entries = indexEntryMapOf(cacheDir);
      expect(Object.keys(entries).sort()).toEqual([HASH_D, HASH_E, HASH_F]);
      expect(entries[HASH_D]).toMatchObject({
        at: expect.any(Number) as number,
        size: pngOf(6, 6).length,
      });
      expect(entries[HASH_F]).toMatchObject({
        at: expect.any(Number) as number,
        size: pngOf(7, 7).length,
      });
    },
  );

  it("should trust a well-formed index row instead of re-deriving it from lstat", async () => {
    const cacheDir = join(dir, "trusted-index", ".hreader", "thumbs");
    const cache = cacheOf("trusted-index");
    await cache.put(HASH_A, pngOf(1, 1));
    await cache.put(HASH_B, pngOf(2, 2));
    // Hand-seed a sentinel `at` on HASH_A's row: a parse that honors the index
    // keeps it; any guard flip that rebuilds rewrites `at` with the file's mtime.
    writeFileSync(
      join(cacheDir, "index.json"),
      JSON.stringify({
        version: 1,
        entries: { [HASH_A]: { at: 42, size: pngOf(1, 1).length } },
      }),
    );

    expect(await cache.get(HASH_B)).toEqual(Buffer.from(pngOf(2, 2)));
    expect(indexEntryMapOf(cacheDir)[HASH_A]?.at).toBe(42);
    // The fetched row is refreshed with a real {at,size} — an empty row would poison eviction.
    expect(indexEntryMapOf(cacheDir)[HASH_B]).toMatchObject({
      at: expect.any(Number) as number,
      size: pngOf(2, 2).length,
    });
  });

  it("should not adopt a directory that merely carries a hash-named .png name", async () => {
    const cacheDir = join(dir, "straydir", ".hreader", "thumbs");
    mkdirSync(join(cacheDir, `${HASH_A}.png`), { recursive: true });
    const cache = cacheOf("straydir");
    await cache.put(HASH_B, pngOf(1, 1));

    const index = JSON.parse(readFileSync(join(cacheDir, "index.json"), "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(index.entries)).toEqual([HASH_B]);
  });
});

const eacces = (): Error => Object.assign(new Error("denied"), { code: "EACCES" });
const enoent = (): Error => Object.assign(new Error("missing"), { code: "ENOENT" });

/** One fs method sabotaged, everything else the real port: each ioFailureOf branch gets its own trigger. */
const failingDeps = (fs: Partial<PatchDeps["fs"]>): PatchDeps => ({
  ...nodePatchDeps,
  clock: clockOf(),
  fs: { ...nodePatchDeps.fs, ...fs },
});

const failingCacheOf = (sub: string, fs: Partial<PatchDeps["fs"]>): ThumbCache =>
  createThumbCache({ dir: join(dir, sub, ".hreader", "thumbs"), deps: failingDeps(fs) });

const indexEntryMapOf = (cacheDir: string): Record<string, { at: number; size: number }> =>
  (
    JSON.parse(readFileSync(join(cacheDir, "index.json"), "utf8")) as {
      entries: Record<string, { at: number; size: number }>;
    }
  ).entries;

const indexEntriesOf = (cacheDir: string): readonly string[] =>
  Object.keys(indexEntryMapOf(cacheDir));

describe("thumbs/cache · io failures", () => {
  it("should surface a cache-dir mkdir failure as io_failure", async () => {
    const cache = failingCacheOf("io-mkdir", { mkdir: () => Promise.reject(eacces()) });
    await expect(cache.put(HASH_A, pngOf(1, 1))).rejects.toMatchObject({
      code: "io_failure",
      message: expect.stringContaining("建缩略图目录") as string,
    });
  });

  it("should surface a cached-PNG write failure as io_failure", async () => {
    const cache = failingCacheOf("io-write", {
      writeFileAtomic: (path, data) =>
        path.endsWith(".png")
          ? Promise.reject(eacces())
          : nodePatchDeps.fs.writeFileAtomic(path, data),
    });
    await expect(cache.put(HASH_A, pngOf(1, 1))).rejects.toMatchObject({
      code: "io_failure",
      message: expect.stringContaining("写缩略图缓存") as string,
    });
  });

  it("should surface an index write failure as io_failure", async () => {
    const cache = failingCacheOf("io-index-write", {
      writeFileAtomic: (path, data) =>
        path.endsWith("index.json")
          ? Promise.reject(eacces())
          : nodePatchDeps.fs.writeFileAtomic(path, data),
    });
    await expect(cache.put(HASH_A, pngOf(1, 1))).rejects.toMatchObject({
      code: "io_failure",
      message: expect.stringContaining("写缩略图索引") as string,
    });
  });

  it("should still serve a hit when the index save fails — the timestamp is only an LRU hint", async () => {
    const cacheDir = join(dir, "io-quiet", ".hreader", "thumbs");
    const png = pngOf(1, 1);
    storeFile(cacheDir, HASH_A, png);
    const cache = failingCacheOf("io-quiet", {
      writeFileAtomic: (path, data) =>
        path.endsWith("index.json")
          ? Promise.reject(eacces())
          : nodePatchDeps.fs.writeFileAtomic(path, data),
    });

    expect(await cache.get(HASH_A)).toEqual(Buffer.from(png));
  });

  it("should surface a cached-PNG read failure as io_failure", async () => {
    const cacheDir = join(dir, "io-read", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, pngOf(1, 1));
    const cache = failingCacheOf("io-read", { readFile: () => Promise.reject(eacces()) });

    await expect(cache.get(HASH_A)).rejects.toMatchObject({
      code: "io_failure",
      message: expect.stringContaining("读取缩略图缓存") as string,
    });
  });

  it("should surface an index read failure as io_failure", async () => {
    const cacheDir = join(dir, "io-index-read", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, pngOf(1, 1));
    const cache = failingCacheOf("io-index-read", {
      readFile: (path) =>
        path.endsWith("index.json") ? Promise.reject(eacces()) : nodePatchDeps.fs.readFile(path),
    });

    await expect(cache.get(HASH_A)).rejects.toMatchObject({
      code: "io_failure",
      message: expect.stringContaining("读取缩略图索引") as string,
    });
  });

  it("should surface a directory listing failure as io_failure", async () => {
    const cacheDir = join(dir, "io-readdir", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, pngOf(1, 1));
    const cache = failingCacheOf("io-readdir", { readdir: () => Promise.reject(eacces()) });

    await expect(cache.get(HASH_A)).rejects.toMatchObject({
      code: "io_failure",
      message: expect.stringContaining("读取缩略图目录") as string,
    });
  });

  it("should treat a vanished cache directory during index load as empty", async () => {
    const cache = failingCacheOf("io-vanished", { readdir: () => Promise.reject(enoent()) });

    await cache.put(HASH_A, pngOf(1, 1));
    expect(await cache.get(HASH_A)).toEqual(Buffer.from(pngOf(1, 1)));
  });

  it("should skip a stray entry that vanishes between readdir and lstat", async () => {
    const cacheDir = join(dir, "vanished-mid-scan", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, pngOf(1, 1));
    const cache = failingCacheOf("vanished-mid-scan", {
      lstat: (path) =>
        path.endsWith(`${HASH_A}.png`) ? Promise.reject(enoent()) : nodePatchDeps.fs.lstat(path),
    });
    await cache.put(HASH_B, pngOf(1, 1));

    expect(indexEntriesOf(cacheDir)).toEqual([HASH_B]);
  });

  it("should still report a miss when removing a corrupt entry fails", async () => {
    const cacheDir = join(dir, "unlink-fail", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, Buffer.from("GIF89a not a png"));
    const cache = failingCacheOf("unlink-fail", { unlink: () => Promise.reject(eacces()) });

    expect(await cache.get(HASH_A)).toBeUndefined();
  });
});
