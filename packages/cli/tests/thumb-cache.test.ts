// This layer covers the `.hreader/thumbs` cache contract on a real temp dir
// (the fs port over node, an injected clock for LRU order, a tiny injected
// limit so eviction needs no 500 MB fixtures): hit/miss, content-keyed
// regeneration, PNG-signature rejection, and least-recently-hit eviction.

import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { nodePatchDeps, type PatchDeps } from "@hreader/core";

import { assertNoHostPaths } from "../../../tests/adversarial/no-host-paths";
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
    workspace: join(dir, sub),
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

    // The evicted row leaves the index in the same write — assert before any
    // get(): a hit's saveIndexQuiet rewrite would heal a stale row back out.
    expect([...indexEntriesOf(cacheDir)].sort()).toEqual([HASH_B, HASH_C, HASH_D]);
    expect(await cache.get(HASH_A)).toBeUndefined();
    expect(await cache.get(HASH_B)).toEqual(Buffer.from(pngOf(2, 2)));
    expect(await cache.get(HASH_C)).toEqual(Buffer.from(pngOf(3, 3)));
    expect(await cache.get(HASH_D)).toEqual(Buffer.from(pngOf(4, 4)));
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
    const cacheDir = join(dir, "rescue", ".hreader", "thumbs");
    await cache.put(HASH_A, pngOf(1, 1));
    await cache.put(HASH_B, pngOf(2, 2));
    await cache.put(HASH_C, pngOf(3, 3));
    // Hit HASH_A: now HASH_B is the least recently hit despite being newer than A.
    expect(await cache.get(HASH_A)).toBeDefined();
    await cache.put(HASH_D, pngOf(4, 4));

    // Index first — before the follow-up get() can reconcile a stale B row away.
    expect([...indexEntriesOf(cacheDir)].sort()).toEqual([HASH_A, HASH_C, HASH_D]);
    expect(await cache.get(HASH_A)).toBeDefined();
    expect(await cache.get(HASH_B)).toBeUndefined();
  });

  it.each([
    { name: "a negative", size: "-1" },
    { name: "an infinite", size: "1e999" },
  ])(
    "should not let $name size defeat eviction — the bogus row is rebuilt from lstat first",
    async ({ size }) => {
      // A `-1` size shrinks the running total (nothing ever evicts); `1e999`
      // parses as Infinity (everything evicts). Either poisons LRU order, so the
      // row must be dropped at load and re-adopted with the file's real size.
      const entry = pngOf(1, 1);
      const sub = `evil-size-${size.length.toString()}`;
      const cacheDir = join(dir, sub, ".hreader", "thumbs");
      const cache = cacheOf(sub, entry.length * 2);
      storeFile(cacheDir, HASH_A, entry);
      storeFile(cacheDir, HASH_B, entry);
      writeFileSync(
        join(cacheDir, "index.json"),
        `{"version":1,"entries":{"${HASH_A}":{"at":1,"size":${size}},"${HASH_B}":{"at":2,"size":${String(entry.length)}}}}`,
      );

      await cache.put(HASH_C, entry);

      // Real total = 3 entries over a 2-entry limit: B (at:2) is oldest — A's
      // lstat mtime is newest, C just landed. Exactly one eviction. The index
      // row leaves with the put — before the get() below can rewrite it.
      expect([...indexEntriesOf(cacheDir)].sort()).toEqual([HASH_A, HASH_C]);
      expect(await cache.get(HASH_B)).toBeUndefined();
      expect(await cache.get(HASH_A)).toEqual(Buffer.from(entry));
    },
  );

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

  it.each([
    { name: "at-string", row: `{"at":"x","size":1}` },
    { name: "at-null", row: `{"at":null,"size":1}` },
    { name: "size-string", row: `{"at":1,"size":"1"}` },
    { name: "size-missing", row: `{"at":1}` },
    { name: "at-missing", row: `{"size":1}` },
    { name: "size-negative", row: `{"at":1,"size":-1}` },
    { name: "size-infinite", row: `{"at":1,"size":1e999}` },
    { name: "at-infinite", row: `{"at":1e999,"size":1}` },
  ])(
    "should drop an index row with a malformed $name and re-adopt the PNG from lstat",
    async ({ name, row }) => {
      // Every field the guard checks is exercised: wrong-typed, null, absent,
      // negative, and non-finite (`1e999` parses as Infinity) values must all
      // land the row in the rebuild bucket, never in the trusted index.
      const sub = `badrow-${name}`;
      const cacheDir = join(dir, sub, ".hreader", "thumbs");
      const cache = cacheOf(sub);
      const png = pngOf(3, 3);
      storeFile(cacheDir, HASH_A, png);
      storeFile(cacheDir, HASH_B, png);
      writeFileSync(
        join(cacheDir, "index.json"),
        `{"version":1,"entries":{"${HASH_A}":${row},"${HASH_B}":{"at":42,"size":${String(png.length)}}}}`,
      );

      await cache.put(HASH_C, png);

      const entries = indexEntryMapOf(cacheDir);
      expect(Object.keys(entries).sort()).toEqual([HASH_A, HASH_B, HASH_C]);
      // Re-adopted, not kept: real file size and a finite mtime — the bogus
      // fields (string, null, absent, negative, infinite) must not survive.
      expect(entries[HASH_A]?.size).toBe(png.length);
      expect(Number.isFinite(entries[HASH_A]?.at)).toBe(true);
      // The honest sibling row was untouched: only the malformed row is rebuilt.
      expect(entries[HASH_B]?.at).toBe(42);
    },
  );

  it("should keep rows that carry extra fields or a zero size — only the two typed fields matter", async () => {
    const sub = "kept-rows";
    const cacheDir = join(dir, sub, ".hreader", "thumbs");
    const cache = cacheOf(sub);
    const png = pngOf(3, 3);
    storeFile(cacheDir, HASH_A, png);
    storeFile(cacheDir, HASH_B, png);
    writeFileSync(
      join(cacheDir, "index.json"),
      `{"version":1,"entries":{"${HASH_A}":{"at":42,"size":${String(png.length)},"x":9,"y":{"z":1}},"${HASH_B}":{"at":7,"size":0}}}`,
    );

    await cache.put(HASH_C, png);

    const entries = indexEntryMapOf(cacheDir);
    // Extra keys do not corrupt a good row — its timestamp is honored verbatim.
    expect(entries[HASH_A]?.at).toBe(42);
    // A zero size is legal bookkeeping: the row stays trusted, not re-adopted.
    expect(entries[HASH_B]).toEqual({ at: 7, size: 0 });
  });

  it("should distrust the whole file when the payload itself is unparseable (a literal NaN)", async () => {
    const sub = "nan-file";
    const cacheDir = join(dir, sub, ".hreader", "thumbs");
    const cache = cacheOf(sub);
    const png = pngOf(3, 3);
    storeFile(cacheDir, HASH_A, png);
    storeFile(cacheDir, HASH_B, png);
    // `NaN` is not JSON: the file fails to parse and EVERY row — even the
    // well-formed B — is rebuilt from lstat.
    writeFileSync(
      join(cacheDir, "index.json"),
      `{"version":1,"entries":{"${HASH_A}":{"at":1,"size":NaN},"${HASH_B}":{"at":42,"size":${String(png.length)}}}}`,
    );

    await cache.put(HASH_C, png);

    const entries = indexEntryMapOf(cacheDir);
    expect(Object.keys(entries).sort()).toEqual([HASH_A, HASH_B, HASH_C]);
    expect(entries[HASH_B]?.at).not.toBe(42);
  });

  it("should distrust a foreign-version index even when every row is well-formed", async () => {
    const sub = "badversion-rows";
    const cacheDir = join(dir, sub, ".hreader", "thumbs");
    const cache = cacheOf(sub);
    const png = pngOf(3, 3);
    storeFile(cacheDir, HASH_A, png);
    // Version marks the whole payload, not row-by-row trust: a well-formed row
    // under a foreign version is rebuilt from lstat like any other stranger.
    writeFileSync(
      join(cacheDir, "index.json"),
      `{"version":2,"entries":{"${HASH_A}":{"at":42,"size":${String(png.length)}}}}`,
    );

    await cache.put(HASH_B, png);

    const entries = indexEntryMapOf(cacheDir);
    expect(Object.keys(entries).sort()).toEqual([HASH_A, HASH_B]);
    expect(entries[HASH_A]?.at).not.toBe(42);
    expect(Number.isFinite(entries[HASH_A]?.at)).toBe(true);
  });

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

const failingCacheOf = (
  sub: string,
  fs: Partial<PatchDeps["fs"]>,
  limitBytes?: number,
): ThumbCache =>
  createThumbCache({
    dir: join(dir, sub, ".hreader", "thumbs"),
    workspace: join(dir, sub),
    deps: failingDeps(fs),
    ...(limitBytes === undefined ? {} : { limitBytes }),
  });

/** io_failure messages may name only the workspace-relative path — an absolute host path must never reach stderr, --json, or an HTTP body. */
const HOST_PATH_FRAGMENTS = ["/Users", "/private", "/tmp", "/var", "/home"] as const;

const ioErrorOf = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: "io_failure" });
    return error as Error;
  }
  throw new Error("expected io_failure but the call succeeded");
};

const expectCleanPath = (error: Error, what: string, shown: string): void => {
  // The full `<what>失败：<shown>` form pins both the message and the display path.
  expect(error.message).toContain(`${what}失败：${shown}`);
  for (const fragment of HOST_PATH_FRAGMENTS) {
    expect(error.message).not.toContain(fragment);
  }
};

const indexEntryMapOf = (cacheDir: string): Record<string, { at: number; size: number }> =>
  (
    JSON.parse(readFileSync(join(cacheDir, "index.json"), "utf8")) as {
      entries: Record<string, { at: number; size: number }>;
    }
  ).entries;

const indexEntriesOf = (cacheDir: string): readonly string[] =>
  Object.keys(indexEntryMapOf(cacheDir));

describe("thumbs/cache · io failures", () => {
  it("should surface a cache-dir mkdir failure as io_failure with the workspace-relative path", async () => {
    const cache = failingCacheOf("io-mkdir", { mkdir: () => Promise.reject(eacces()) });
    const error = await ioErrorOf(() => cache.put(HASH_A, pngOf(1, 1)));
    expectCleanPath(error, "建缩略图目录", ".hreader/thumbs");
  });

  it("should surface a cached-PNG write failure as io_failure with the workspace-relative path", async () => {
    const cache = failingCacheOf("io-write", {
      writeFileAtomic: (path, data) =>
        path.endsWith(".png")
          ? Promise.reject(eacces())
          : nodePatchDeps.fs.writeFileAtomic(path, data),
    });
    const error = await ioErrorOf(() => cache.put(HASH_A, pngOf(1, 1)));
    expectCleanPath(error, "写缩略图缓存", `.hreader/thumbs/${HASH_A}.png`);
  });

  it("should surface an index write failure as io_failure with the workspace-relative path", async () => {
    const cache = failingCacheOf("io-index-write", {
      writeFileAtomic: (path, data) =>
        path.endsWith("index.json")
          ? Promise.reject(eacces())
          : nodePatchDeps.fs.writeFileAtomic(path, data),
    });
    const error = await ioErrorOf(() => cache.put(HASH_A, pngOf(1, 1)));
    expectCleanPath(error, "写缩略图索引", ".hreader/thumbs/index.json");
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

  it("should surface a cached-PNG read failure as io_failure with the workspace-relative path", async () => {
    const cacheDir = join(dir, "io-read", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, pngOf(1, 1));
    const cache = failingCacheOf("io-read", { readFile: () => Promise.reject(eacces()) });

    const error = await ioErrorOf(() => cache.get(HASH_A));
    expectCleanPath(error, "读取缩略图缓存", `.hreader/thumbs/${HASH_A}.png`);
  });

  it("should surface an index read failure as io_failure with the workspace-relative path", async () => {
    const cacheDir = join(dir, "io-index-read", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, pngOf(1, 1));
    const cache = failingCacheOf("io-index-read", {
      readFile: (path) =>
        path.endsWith("index.json") ? Promise.reject(eacces()) : nodePatchDeps.fs.readFile(path),
    });

    const error = await ioErrorOf(() => cache.get(HASH_A));
    expectCleanPath(error, "读取缩略图索引", ".hreader/thumbs/index.json");
  });

  it("should surface a directory listing failure as io_failure with the workspace-relative path", async () => {
    const cacheDir = join(dir, "io-readdir", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, pngOf(1, 1));
    const cache = failingCacheOf("io-readdir", { readdir: () => Promise.reject(eacces()) });

    const error = await ioErrorOf(() => cache.get(HASH_A));
    expectCleanPath(error, "读取缩略图目录", ".hreader/thumbs");
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

  it("should surface an entry lstat failure as io_failure with the workspace-relative path", async () => {
    const cacheDir = join(dir, "io-lstat", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, pngOf(1, 1));
    const cache = failingCacheOf("io-lstat", { lstat: () => Promise.reject(eacces()) });

    const error = await ioErrorOf(() => cache.get(HASH_A));
    expectCleanPath(error, "检查缩略图缓存", `.hreader/thumbs/${HASH_A}.png`);
  });

  it("should surface an eviction delete failure as io_failure with the workspace-relative path", async () => {
    const entry = pngOf(1, 1);
    const cacheDir = join(dir, "io-evict-unlink", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, entry);
    const cache = failingCacheOf(
      "io-evict-unlink",
      { unlink: () => Promise.reject(eacces()) },
      entry.length,
    );

    // Limit holds one entry: B's put must evict A — and the delete fails.
    const error = await ioErrorOf(() => cache.put(HASH_B, entry));
    expectCleanPath(error, "删缩略图缓存", `.hreader/thumbs/${HASH_A}.png`);
  });

  it("should treat an eviction delete that hits ENOENT as already gone", async () => {
    const entry = pngOf(1, 1);
    const cacheDir = join(dir, "evict-vanished", ".hreader", "thumbs");
    storeFile(cacheDir, HASH_A, entry);
    const cache = failingCacheOf(
      "evict-vanished",
      { unlink: () => Promise.reject(enoent()) },
      entry.length,
    );

    // Another process deleted A first — the eviction still drops its index row.
    await cache.put(HASH_B, entry);
    expect(indexEntriesOf(cacheDir)).toEqual([HASH_B]);
  });

  it("should refuse with path_outside_workspace when the landing cannot be resolved", async () => {
    // Fail closed like assertParentInside: an unresolvable path proves nothing.
    const cache = failingCacheOf("io-realpath", { realpath: () => Promise.reject(eacces()) });

    const error = await cache.get(HASH_A).then(
      () => {
        throw new Error("expected path_outside_workspace but the call succeeded");
      },
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "path_outside_workspace" });
    expect((error as Error).message).toContain(".hreader");
    assertNoHostPaths((error as Error).message, []);
  });
});

describe("thumbs/cache · symlink containment", () => {
  // Real fs + real symlinks (no chmod needed): every cache op must refuse when
  // any component of `.hreader/thumbs` escapes the workspace — the same
  // containment rule atomic.ts applies to the other `.hreader` stores. The
  // asserts that matter: outside bytes byte-identical before and after, the
  // error is path_outside_workspace, and the message never leaks a host path.

  interface EscapeDirs {
    readonly ws: string;
    readonly outside: string;
    readonly cacheDir: string;
  }

  const escapeDirs = (name: string): EscapeDirs => {
    const ws = join(dir, name, "ws");
    const outside = join(dir, name, "outside");
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    return { ws, outside, cacheDir: join(ws, ".hreader", "thumbs") };
  };

  const escapedCacheOf = (ws: string, limitBytes?: number): ThumbCache =>
    createThumbCache({
      dir: join(ws, ".hreader", "thumbs"),
      workspace: ws,
      deps: depsOf(),
      ...(limitBytes === undefined ? {} : { limitBytes }),
    });

  const bytesOf = (path: string): string => readFileSync(path, "utf8");

  const expectContained = async (work: () => Promise<unknown>, roots: readonly string[]) => {
    const error = await work().then(
      () => {
        throw new Error("expected path_outside_workspace but the call succeeded");
      },
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "path_outside_workspace" });
    // The message must name the workspace-relative path (an empty or absolute one fails the contract).
    expect((error as Error).message).toContain(".hreader");
    assertNoHostPaths((error as Error).message, roots);
  };

  it.each([
    {
      name: ".hreader/thumbs",
      // The link IS the cache dir → ops land directly under `outside`.
      resolvedCacheDir: (outside: string) => outside,
      link: (ws: string, outside: string) => {
        mkdirSync(join(ws, ".hreader"));
        symlinkSync(outside, join(ws, ".hreader", "thumbs"));
      },
    },
    {
      name: ".hreader",
      // `.hreader` is the link → `<ws>/.hreader/thumbs/x` resolves to `outside/thumbs/x`.
      resolvedCacheDir: (outside: string) => join(outside, "thumbs"),
      link: (ws: string, outside: string) => {
        symlinkSync(outside, join(ws, ".hreader"));
      },
    },
  ])(
    "should refuse get and put when $name symlinks outside the workspace",
    async ({ name, resolvedCacheDir, link }) => {
      const { ws, outside, cacheDir } = escapeDirs(`link-${name.replaceAll("/", "-")}`);
      const victimDir = resolvedCacheDir(outside);
      mkdirSync(victimDir, { recursive: true });
      const victimPng = join(victimDir, `${HASH_A}.png`);
      const victimIndex = join(victimDir, "index.json");
      writeFileSync(victimPng, "outside victim bytes");
      writeFileSync(victimIndex, `{"version":1,"entries":{"${HASH_A}":{"at":1,"size":999999999}}}`);
      link(ws, outside);
      const cache = escapedCacheOf(ws);

      await expectContained(() => cache.get(HASH_A), [ws, outside]);
      await expectContained(() => cache.put(HASH_A, pngOf(1, 1)), [ws, outside]);
      // Nothing outside was read into a result, written over, or deleted through the link.
      expect(bytesOf(victimPng)).toBe("outside victim bytes");
      expect(bytesOf(victimIndex)).toContain("999999999");
      // The workspace side never gained a real cache dir through the operation either.
      expect(cacheDir.endsWith(join(".hreader", "thumbs"))).toBe(true);
    },
  );

  it("should refuse a symlinked <hash>.png entry — never follow it, never delete its target", async () => {
    const { ws, outside, cacheDir } = escapeDirs("link-png");
    mkdirSync(cacheDir, { recursive: true });
    const victim = join(outside, "victim.png");
    writeFileSync(victim, "outside victim bytes");
    symlinkSync(victim, join(cacheDir, `${HASH_A}.png`));
    const cache = escapedCacheOf(ws, pngOf(1, 1).length * 2);
    const roots = [ws, outside] as const;

    // Read-through is refused.
    await expectContained(() => cache.get(HASH_A), roots);
    // Overwrite-through is refused too (put at that hash).
    await expectContained(() => cache.put(HASH_A, pngOf(1, 1)), roots);
    expect(bytesOf(victim)).toBe("outside victim bytes");
  });

  it("should refuse a symlinked entry even when the link's target is inside the workspace", async () => {
    // A link is refused on principle — contained checks the *target*, but the
    // link itself must never be followed, overwritten through, or deleted.
    const { ws, cacheDir } = escapeDirs("link-png-inside");
    mkdirSync(cacheDir, { recursive: true });
    const victim = join(ws, "victim.png");
    writeFileSync(victim, "inside-victim bytes");
    symlinkSync(victim, join(cacheDir, `${HASH_A}.png`));
    const cache = escapedCacheOf(ws);

    await expectContained(() => cache.get(HASH_A), [ws]);
    await expectContained(() => cache.put(HASH_A, pngOf(1, 1)), [ws]);
    expect(bytesOf(victim)).toBe("inside-victim bytes");
  });

  it("should refuse to evict through a symlinked entry — put fails, the victim keeps its bytes", async () => {
    const { ws, outside, cacheDir } = escapeDirs("link-evict");
    mkdirSync(cacheDir, { recursive: true });
    const victim = join(outside, `${HASH_A}.png`);
    writeFileSync(victim, "outside victim bytes");
    symlinkSync(victim, join(cacheDir, `${HASH_A}.png`));
    storeFile(cacheDir, HASH_B, pngOf(1, 1));
    const entry = pngOf(1, 1);
    writeFileSync(
      join(cacheDir, "index.json"),
      `{"version":1,"entries":{"${HASH_A}":{"at":1,"size":${String(entry.length)}},"${HASH_B}":{"at":2,"size":${String(entry.length)}}}}`,
    );
    const cache = escapedCacheOf(ws, entry.length * 2);

    // A is oldest → the evicting put must try to delete it, hit the refusal, and fail the whole put.
    await expectContained(() => cache.put(HASH_C, entry), [ws, outside]);
    expect(bytesOf(victim)).toBe("outside victim bytes");
  });

  it("should refuse a symlinked index.json — never read rows from it or write through it", async () => {
    const { ws, outside, cacheDir } = escapeDirs("link-index");
    mkdirSync(cacheDir, { recursive: true });
    const victim = join(outside, "index.json");
    writeFileSync(
      victim,
      `{"version":1,"entries":{"${HASH_A}":{"at":1,"size":${String(pngOf(1, 1).length)}}}}`,
    );
    symlinkSync(victim, join(cacheDir, "index.json"));
    storeFile(cacheDir, HASH_A, pngOf(1, 1));
    const cache = escapedCacheOf(ws);
    const roots = [ws, outside] as const;

    // A hit reaches loadIndex; a miss-path put reaches it too. Both must refuse.
    await expectContained(() => cache.get(HASH_A), roots);
    await expectContained(() => cache.put(HASH_B, pngOf(2, 2)), roots);
    expect(bytesOf(victim)).toContain('"entries"');
    expect(bytesOf(victim)).toContain(HASH_A);
  });

  it("should serve normally again once the link is gone", async () => {
    const { ws, outside, cacheDir } = escapeDirs("link-heal");
    mkdirSync(join(ws, ".hreader"));
    symlinkSync(outside, join(ws, ".hreader", "thumbs"));
    const cache = escapedCacheOf(ws);
    await expectContained(() => cache.put(HASH_A, pngOf(1, 1)), [ws, outside]);

    rmSync(join(ws, ".hreader", "thumbs"));
    await cache.put(HASH_A, pngOf(1, 1));
    expect(await cache.get(HASH_A)).toEqual(Buffer.from(pngOf(1, 1)));
    expect(readFileSync(join(cacheDir, `${HASH_A}.png`))).toEqual(Buffer.from(pngOf(1, 1)));
  });
});
