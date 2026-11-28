// This layer covers `createThumbRender`'s composition: cache hit short-circuits,
// a miss single-flights through the queue into one render + one cache put, the
// source is classified like the export path (managed -> print sheet, foreign ->
// capability plan), and render failures propagate without poisoning the cache.
// All seams are fakes — no Chrome, no queue timing, no disk beyond fixture docs.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { HrError, nodePatchDeps, type PatchDeps } from "@hreader/core";

import type { RenderSource } from "../src/chrome/types";
import type { ThumbCache } from "../src/thumbs/cache";
import { createRenderQueue } from "../src/thumbs/queue";
import { createThumbRender, type ThumbSession } from "../src/thumbs/service";
import { pngOf } from "./chrome-png";

const dir = mkdtempSync(join(tmpdir(), "hr-thumb-svc-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MANAGED =
  '<!doctype html><html><body><article data-hr-id="hr-a"><p>正文</p></article></body></html>';
// Foreign = zero <article> (or 2+); a lone id-less one is "normalizable" and still takes the sheet.
const FOREIGN = "<!doctype html><html><body><h1>no ids</h1><p>plain</p></body></html>";

const seed = (name: string, html: string): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

const NEVER = new Promise<void>(() => undefined);
const HASH = "ab".repeat(32);

interface FakeCache extends ThumbCache {
  readonly gets: string[];
  readonly puts: string[];
  readonly stored: Map<string, Uint8Array>;
}

const fakeCacheOf = (): FakeCache => {
  const stored = new Map<string, Uint8Array>();
  const gets: string[] = [];
  const puts: string[] = [];
  return {
    stored,
    gets,
    puts,
    get: async (hash) => {
      gets.push(hash);
      return await Promise.resolve(stored.get(hash));
    },
    put: async (hash, bytes) => {
      puts.push(hash);
      stored.set(hash, bytes);
      await Promise.resolve();
    },
  };
};

const serviceOf = (overrides: {
  readonly render?: ThumbSession;
  readonly cache?: ThumbCache;
  readonly sources?: RenderSource[];
}) => {
  const sources = overrides.sources ?? [];
  const render: ThumbSession =
    overrides.render ??
    (async (source) => {
      sources.push(source);
      return await Promise.resolve(pngOf(600, 400));
    });
  return {
    sources,
    cache: overrides.cache,
    thumb: createThumbRender({
      workspace: dir,
      home: join(dir, "home"),
      env: {},
      stop: NEVER,
      timeoutMs: 1000,
      warn: () => undefined,
      render,
      ...(overrides.cache === undefined ? {} : { cache: overrides.cache }),
    }),
  };
};

describe("thumbs/service · cache interaction", () => {
  it("should serve a cache hit without touching the queue or the renderer", async () => {
    const cache = fakeCacheOf();
    const stored = pngOf(600, 400);
    cache.stored.set(HASH, stored);
    let renders = 0;
    let submits = 0;
    // A hand-built thumb: the queue spy must see zero submits on a hit — the
    // inner re-check would mask a fall-through (same answer, wrong path).
    const thumb = createThumbRender({
      workspace: dir,
      home: join(dir, "home"),
      env: {},
      stop: NEVER,
      timeoutMs: 1000,
      warn: () => undefined,
      cache,
      queue: {
        submit: async (_key, work) => {
          submits += 1;
          return await work();
        },
      },
      render: async () => {
        renders += 1;
        return await Promise.resolve(pngOf(1, 1));
      },
    });

    const result = await thumb({ path: seed("hit.html", MANAGED), hash: HASH });
    expect(result).toEqual(stored);
    expect(renders).toBe(0);
    expect(submits).toBe(0);
    expect(cache.puts).toEqual([]);
  });

  it("should render once on a miss and store the bytes under the hash", async () => {
    const cache = fakeCacheOf();
    const produced = pngOf(600, 400);
    const { thumb } = serviceOf({
      cache,
      render: () => Promise.resolve(produced),
    });
    const doc = seed("miss.html", MANAGED);

    const result = await thumb({ path: doc, hash: HASH });
    expect(result).toEqual(produced);
    expect(cache.puts).toEqual([HASH]);
    expect(await cache.get(HASH)).toEqual(produced);
  });

  it("should re-check the cache inside the queue slot (a same-hash generation that finished while we queued fills the answer)", async () => {
    const stored = pngOf(600, 400);
    let gets = 0;
    const cacheWithLatch: ThumbCache = {
      get: async () => {
        gets += 1;
        // First get = the outer miss; the queue's inner get finds the winner's bytes.
        return await Promise.resolve(gets === 1 ? undefined : stored);
      },
      put: () => Promise.resolve(),
    };
    let renders = 0;
    const { thumb } = serviceOf({
      cache: cacheWithLatch,
      render: async () => {
        renders += 1;
        return await Promise.resolve(pngOf(1, 1));
      },
    });

    const result = await thumb({ path: seed("race.html", MANAGED), hash: HASH });
    expect(result).toEqual(stored);
    expect(renders).toBe(0);
  });
});

describe("thumbs/service · single-flight through the real queue", () => {
  it("should share one generation between concurrent same-hash requests", async () => {
    const cache = fakeCacheOf();
    let renders = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { thumb } = serviceOf({
      cache,
      render: async (source) => {
        renders += 1;
        await gate;
        expect(source.kind).toBe("sheet");
        return pngOf(600, 400);
      },
    });
    const doc = seed("shared.html", MANAGED);

    const first = thumb({ path: doc, hash: HASH });
    const second = thumb({ path: doc, hash: HASH });
    await Promise.resolve();
    await Promise.resolve();
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(renders).toBe(1);
    expect(cache.puts).toEqual([HASH]);
  });
});

describe("thumbs/service · source classification", () => {
  it("should hand a managed document to the print sheet and a foreign one to the capability plan", async () => {
    const sources: RenderSource[] = [];
    const { thumb } = serviceOf({ sources });

    await thumb({ path: seed("managed.html", MANAGED), hash: HASH });
    await thumb({ path: seed("foreign.html", FOREIGN), hash: HASH.replace("a", "c") });

    expect(sources.map((source) => source.kind)).toEqual(["sheet", "foreign"]);
  });
});

describe("thumbs/service · failure propagation", () => {
  it("should propagate the render failure and write nothing to the cache", async () => {
    const cache = fakeCacheOf();
    const { thumb } = serviceOf({
      cache,
      render: () => Promise.reject(new HrError("chrome_missing", "找不到 Chrome")),
    });

    await expect(thumb({ path: seed("fails.html", MANAGED), hash: HASH })).rejects.toMatchObject({
      code: "chrome_missing",
    });
    expect(cache.puts).toEqual([]);
    expect(cache.stored.size).toBe(0);
  });

  it("should stay usable after a failed generation", async () => {
    const cache = fakeCacheOf();
    let fail = true;
    const { thumb } = serviceOf({
      cache,
      render: async () => {
        if (fail) return await Promise.reject(new HrError("render_timeout", "超时"));
        return await Promise.resolve(pngOf(600, 400));
      },
    });
    const doc = seed("retry.html", MANAGED);

    await expect(thumb({ path: doc, hash: HASH })).rejects.toMatchObject({
      code: "render_timeout",
    });
    fail = false;
    await expect(thumb({ path: doc, hash: HASH })).resolves.toEqual(pngOf(600, 400));
  });
});

describe("thumbs/service · io_failure propagation", () => {
  it("should surface a cache io failure carrying only the workspace-relative path", async () => {
    // The real cache, an fs fault on mkdir, a fake render — the thrown message is
    // what both hosts echo (CLI stderr/--json verbatim; the serve route maps
    // io_failure to a fixed body, so it can never leak a host path).
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    const deps: PatchDeps = {
      ...nodePatchDeps,
      fs: { ...nodePatchDeps.fs, mkdir: () => Promise.reject(eacces) },
    };
    // Own workspace: sibling tests run the REAL default cache under `dir` and
    // leave entries behind — a private root keeps this a deterministic miss.
    const ws = join(dir, "iofail-ws");
    mkdirSync(ws, { recursive: true });
    const thumb = createThumbRender({
      workspace: ws,
      home: join(dir, "home"),
      env: {},
      stop: NEVER,
      timeoutMs: 1000,
      warn: () => undefined,
      deps,
      render: () => Promise.resolve(pngOf(600, 400)),
    });
    const doc = join(ws, "iofail.html");
    writeFileSync(doc, MANAGED);

    try {
      await thumb({ path: doc, hash: HASH });
      expect.unreachable("the cache mkdir must fail");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "io_failure" });
      const message = (error as Error).message;
      expect(message).toContain("建缩略图目录失败：.hreader/thumbs");
      for (const fragment of ["/Users", "/private", "/tmp", "/var", "/home"]) {
        expect(message).not.toContain(fragment);
      }
    }
  });
});

describe("thumbs/service · the real queue bounds concurrency", () => {
  it("should serialize different hashes through createRenderQueue", async () => {
    const cache = fakeCacheOf();
    let active = 0;
    let peak = 0;
    const render: ThumbSession = async () => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await Promise.resolve(pngOf(600, 400));
      } finally {
        active -= 1;
      }
    };
    const thumb = createThumbRender({
      workspace: dir,
      home: join(dir, "home"),
      env: {},
      stop: NEVER,
      timeoutMs: 1000,
      warn: () => undefined,
      render,
      cache,
      queue: createRenderQueue(),
    });
    const doc = seed("serial.html", MANAGED);

    await Promise.all([
      thumb({ path: doc, hash: "a".repeat(64) }),
      thumb({ path: doc, hash: "b".repeat(64) }),
      thumb({ path: doc, hash: "c".repeat(64) }),
    ]);
    expect(peak).toBe(1);
  });
});
