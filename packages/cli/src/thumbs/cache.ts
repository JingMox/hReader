// This layer: the on-disk thumbnail cache — `<workspace>/.hreader/thumbs/<sha256>.png`
// plus a small `index.json` carrying each entry's last-hit timestamp and byte size.
// LRU ordering lives in the index (`at` = last hit), not fs atime: atime semantics
// vary by mount and the fs port has no utimes — an index is explicit and testable.
// The filename is the content hash, never derived from the document path, and all
// writes stay inside the cache directory.

import { join } from "node:path";

import { HrError, type PatchDeps } from "@hreader/core";

import { assertPngOf } from "../chrome/png";
import { ioFailureOf } from "../commands/export-print";

/** Spec: evict when the cache directory exceeds 500 MB (524288000 bytes) — counted as PNG bytes (the index file itself is a few KB of bookkeeping). */
const THUMB_CACHE_LIMIT_BYTES = 524_288_000;

const INDEX_FILE = "index.json";
const INDEX_VERSION = 1;

/** io_failure messages name the path the user recognizes — workspace-relative — never the host's absolute one (stderr, --json and the HTTP boundary all echo it). */
const DISPLAY_DIR = join(".hreader", "thumbs");
const displayPathOf = (name: string): string => join(DISPLAY_DIR, name);

/** A cache entry's only legal filename: lowercase sha256 hex. Anything else would let a caller name paths inside the directory. */
const HASH_RE = /^[0-9a-f]{64}$/u;

interface CacheEntry {
  /** Last-hit timestamp (ms since epoch, from `deps.clock`) — the LRU key. */
  readonly at: number;
  readonly size: number;
}

type CacheIndex = Record<string, CacheEntry>;

const pngNameOf = (hash: string): string => `${hash}.png`;

const isMissing = (error: unknown): boolean => Reflect.get(Object(error), "code") === "ENOENT";

const assertHash = (hash: string): void => {
  if (!HASH_RE.test(hash)) {
    throw new HrError("invalid_input", `缩略图缓存键不是 sha256 hex：${hash}`);
  }
};

const unlinkQuiet = async (fsApi: PatchDeps["fs"], path: string): Promise<void> => {
  try {
    await fsApi.unlink(path);
  } catch {
    // Already gone (or never ours): a missing entry needs no cleanup.
  }
};

/** Index entry shape guard: a corrupt index file is rebuilt from the directory rather than trusted.
 * `isFinite` earns its keep — `1e999` parses as Infinity — and a non-finite or
 * negative `size` would corrupt the eviction total, so those rows are dropped
 * and the file re-adopted from lstat like any other stray. */
const isCacheEntry = (value: unknown): value is CacheEntry => {
  if (typeof value !== "object" || value === null) return false;
  const at: unknown = Reflect.get(value, "at");
  const size: unknown = Reflect.get(value, "size");
  return Number.isFinite(at) && typeof size === "number" && Number.isFinite(size) && size >= 0;
};

const parseIndex = (text: string): CacheIndex | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (Reflect.get(parsed, "version") !== INDEX_VERSION) return undefined;
    const entries: unknown = Reflect.get(parsed, "entries");
    if (typeof entries !== "object" || entries === null) return undefined;
    const index: CacheIndex = {};
    for (const [hash, entry] of Object.entries(entries)) {
      if (HASH_RE.test(hash) && isCacheEntry(entry)) index[hash] = entry;
    }
    return index;
  } catch {
    return undefined;
  }
};

export interface ThumbCache {
  /**
   * The cached PNG for `hash`, or `undefined` on a miss. A corrupt or truncated
   * file fails the PNG signature check, is unlinked, and reads as a miss —
   * the caller regenerates.
   */
  readonly get: (hash: string) => Promise<Uint8Array | undefined>;
  /** Store `bytes` under `hash`, then evict least-recently-hit entries while the cache exceeds the limit. */
  readonly put: (hash: string, bytes: Uint8Array) => Promise<void>;
}

export const createThumbCache = (input: {
  readonly dir: string;
  readonly deps: PatchDeps;
  /** Default {@link THUMB_CACHE_LIMIT_BYTES}; injectable for tests (500 MiB fixtures are not). */
  readonly limitBytes?: number;
}): ThumbCache => {
  const { dir, deps } = input;
  const limit = input.limitBytes ?? THUMB_CACHE_LIMIT_BYTES;
  const indexPath = join(dir, INDEX_FILE);

  /**
   * The index is a cache, not a ledger: it is rebuilt from the directory on
   * every load — index entries whose PNG vanished drop out, and stray PNGs
   * (another process's write, a restored backup) join with their mtime as `at`.
   */
  const loadIndex = async (): Promise<CacheIndex> => {
    let index: CacheIndex = {};
    try {
      index = parseIndex(new TextDecoder().decode(await deps.fs.readFile(indexPath))) ?? {};
    } catch (error: unknown) {
      if (!isMissing(error)) throw ioFailureOf(error, "读取缩略图索引", displayPathOf(INDEX_FILE));
    }
    let names: readonly string[];
    try {
      names = await deps.fs.readdir(dir);
    } catch (error: unknown) {
      if (isMissing(error)) return index;
      throw ioFailureOf(error, "读取缩略图目录", DISPLAY_DIR);
    }
    const present = new Set(names);
    index = Object.fromEntries(
      Object.entries(index).filter(([hash]) => present.has(pngNameOf(hash))),
    );
    for (const name of names) {
      const hash = name.endsWith(".png") ? name.slice(0, -".png".length) : "";
      if (!HASH_RE.test(hash) || index[hash] !== undefined) continue;
      try {
        const stat = await deps.fs.lstat(join(dir, name));
        if (stat.isFile()) index[hash] = { at: stat.mtimeMs, size: stat.size };
      } catch {
        // The file vanished mid-scan — skip it; it earns no cache entry either way.
      }
    }
    return index;
  };

  const saveIndex = async (index: CacheIndex): Promise<void> => {
    const data = new TextEncoder().encode(
      JSON.stringify({ version: INDEX_VERSION, entries: index }),
    );
    try {
      await deps.fs.writeFileAtomic(indexPath, data);
    } catch (error: unknown) {
      throw ioFailureOf(error, "写缩略图索引", displayPathOf(INDEX_FILE));
    }
  };

  /** `at` updates are bookkeeping hints: a stale timestamp is worth an eviction mistake, not a failed thumbnail. */
  const saveIndexQuiet = async (index: CacheIndex): Promise<void> => {
    try {
      await saveIndex(index);
    } catch {
      // See above: the PNG is already served; only LRU accuracy degrades.
    }
  };

  /** Evicted entries leave the returned copy; `index` itself is read-only here. */
  const evict = async (index: CacheIndex, keep: string): Promise<CacheIndex> => {
    let total = Object.values(index).reduce((sum, entry) => sum + entry.size, 0);
    const oldestFirst = Object.entries(index)
      .filter(([hash]) => hash !== keep)
      .sort(([, entryA], [, entryB]) => entryA.at - entryB.at);
    const dropped = new Set<string>();
    for (const [hash, entry] of oldestFirst) {
      if (total <= limit) break;
      total -= entry.size;
      dropped.add(hash);
      await unlinkQuiet(deps.fs, join(dir, pngNameOf(hash)));
    }
    return Object.fromEntries(Object.entries(index).filter(([hash]) => !dropped.has(hash)));
  };

  return {
    get: async (hash) => {
      assertHash(hash);
      const path = join(dir, pngNameOf(hash));
      let bytes: Uint8Array;
      try {
        bytes = await deps.fs.readFile(path);
      } catch (error: unknown) {
        if (isMissing(error)) return undefined;
        throw ioFailureOf(error, "读取缩略图缓存", displayPathOf(pngNameOf(hash)));
      }
      try {
        assertPngOf(bytes);
      } catch {
        // Corrupt or truncated (signature/IHDR fails): treat as a miss so the
        // caller regenerates, and drop the bad file so later hits skip it too.
        await unlinkQuiet(deps.fs, path);
        return undefined;
      }
      const index = await loadIndex();
      index[hash] = { at: deps.clock.now().getTime(), size: bytes.length };
      await saveIndexQuiet(index);
      return bytes;
    },
    put: async (hash, bytes) => {
      assertHash(hash);
      try {
        await deps.fs.mkdir(dir);
      } catch (error: unknown) {
        throw ioFailureOf(error, "建缩略图目录", DISPLAY_DIR);
      }
      const path = join(dir, pngNameOf(hash));
      try {
        await deps.fs.writeFileAtomic(path, bytes);
      } catch (error: unknown) {
        throw ioFailureOf(error, "写缩略图缓存", displayPathOf(pngNameOf(hash)));
      }
      const index = await loadIndex();
      index[hash] = { at: deps.clock.now().getTime(), size: bytes.length };
      // The just-written entry never evicts itself: `put` must leave its own bytes fetchable.
      await saveIndex(await evict(index, hash));
    },
  };
};
