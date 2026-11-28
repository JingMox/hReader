// This layer owns the document-metadata HTTP surface: `GET`/`POST /api/doc/<docId>/meta`.
// Auth layering is the same as every other doc route; HTML bytes are never touched by a
// meta write; a successful write broadcasts `doc.meta`, a failed one broadcasts nothing.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cookieOf,
  defaultSeed,
  httpCall,
  jsonBodyOf,
  openSse,
  withServer,
  type HttpResponse,
  type TestServer,
} from "./harness";
import { withPost } from "./wire";

interface WireMeta {
  readonly tags: readonly string[];
  readonly sourceUrl: string | null;
  readonly createdBy: string | null;
  readonly savedAt: string | null;
  readonly diagnostics: readonly string[];
}

interface WireMetaWrite extends WireMeta {
  readonly changed: boolean;
  readonly revision: string;
}

const getMeta = async (ctx: TestServer, docId: string): Promise<HttpResponse> =>
  httpCall(ctx.port, {
    path: `/api/doc/${docId}/meta`,
    headers: { cookie: cookieOf(ctx.token) },
  });

const postMeta = async (
  ctx: TestServer,
  docId: string,
  body: unknown = {},
): Promise<HttpResponse> =>
  httpCall(ctx.port, {
    method: "POST",
    path: `/api/doc/${docId}/meta`,
    headers: withPost(ctx.token),
    body: JSON.stringify(body),
  });

const tablePath = (ctx: TestServer): string => join(ctx.workspace, ".hreader", "meta.json");

const fileStateOf = (path: string): { readonly bytes: Buffer; readonly mtimeMs: number } => ({
  bytes: readFileSync(path),
  mtimeMs: statSync(path).mtimeMs,
});

const settle = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("meta routes · auth", () => {
  it("should answer 401 without a cookie on the read", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/api/doc/doc.html/meta" });

      expect(response.status).toBe(401);
      expect(response.body).toContain("unauthorized");
    }, defaultSeed);
  });

  it("should answer 401 without a cookie on the write", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/meta",
        headers: { "x-hr-csrf": "1", "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain("unauthorized");
    }, defaultSeed);
  });

  it("should answer 403 without the CSRF header on the write", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/meta",
        headers: { cookie: cookieOf(ctx.token), "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(403);
      expect(response.body).toContain("forbidden_origin");
    }, defaultSeed);
  });

  it("should answer 403 for Origin: null — the null exception is /f/-only", async () => {
    await withServer(async (ctx) => {
      const read = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/meta",
        headers: { cookie: cookieOf(ctx.token), origin: "null" },
      });
      const write = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/meta",
        headers: { ...withPost(ctx.token), origin: "null" },
        body: "{}",
      });

      expect(read.status).toBe(403);
      expect(write.status).toBe(403);
    }, defaultSeed);
  });

  it("should answer 404 for an unknown document", async () => {
    await withServer(async (ctx) => {
      const read = await getMeta(ctx, "missing.html");
      const write = await postMeta(ctx, "missing.html", { tags: ["x"] });

      expect(read.status).toBe(404);
      expect(read.body).toContain("not_a_file");
      expect(write.status).toBe(404);
      expect(write.body).toContain("not_a_file");
    }, defaultSeed);
  });
});

describe("meta routes · read", () => {
  it("should return all-empty fields for a doc with no metadata", async () => {
    await withServer(async (ctx) => {
      const response = await getMeta(ctx, "doc.html");

      expect(response.status).toBe(200);
      expect(jsonBodyOf(response)).toEqual({
        tags: [],
        sourceUrl: null,
        createdBy: null,
        savedAt: null,
        diagnostics: [],
      });
      expect(existsSync(tablePath(ctx))).toBe(false);
    }, defaultSeed);
  });
});

describe("meta routes · strict body", () => {
  it.each([
    ["an unknown key", { bogus: 1 }],
    ["a __proto__ key", JSON.parse('{"__proto__":{"x":1}}') as object],
    ["tags not an array", { tags: "x" }],
    ["tags with a non-string", { tags: [1] }],
    ["addTags not an array", { addTags: "x" }],
    ["removeTags not an array", { removeTags: {} }],
    ["sourceUrl not a string or null", { sourceUrl: 42 }],
    ["a non-object body", [1, 2]],
  ])("should answer 400 invalid_request/invalid_payload for %s", async (_l, body) => {
    await withServer(async (ctx) => {
      const response = await postMeta(ctx, "doc.html", body);

      expect(response.status).toBe(400);
      expect(response.body).toMatch(/invalid_request|invalid_payload/u);
      expect(existsSync(tablePath(ctx))).toBe(false);
    }, defaultSeed);
  });

  it("should answer 400 when the body's docId contradicts the path", async () => {
    await withServer(async (ctx) => {
      const response = await postMeta(ctx, "doc.html", {
        docId: "other.html",
        tags: ["x"],
      });

      expect(response.status).toBe(400);
      expect(response.body).toContain("invalid_payload");
    }, defaultSeed);
  });

  it("should accept a body docId matching the path", async () => {
    await withServer(async (ctx) => {
      const response = await postMeta(ctx, "doc.html", { docId: "doc.html", tags: ["x"] });

      expect(response.status).toBe(200);
      expect((jsonBodyOf(response) as WireMetaWrite).tags).toEqual(["x"]);
    }, defaultSeed);
  });

  it("should answer 400 invalid_payload for a semantic violation (bad URL)", async () => {
    await withServer(async (ctx) => {
      const response = await postMeta(ctx, "doc.html", { sourceUrl: "javascript:x" });

      expect(response.status).toBe(400);
      expect(response.body).toContain("invalid_payload");
    }, defaultSeed);
  });
});

describe("meta routes · merged write", () => {
  it("should merge only the given fields and report changed/revision", async () => {
    await withServer(async (ctx) => {
      const before = fileStateOf(ctx.file);

      const first = await postMeta(ctx, "doc.html", { tags: ["一", "二"] });
      expect(first.status).toBe(200);
      const firstBody = jsonBodyOf(first) as WireMetaWrite;
      expect(firstBody).toMatchObject({
        tags: ["一", "二"],
        sourceUrl: null,
        createdBy: "user",
        changed: true,
      });
      expect(firstBody.savedAt).not.toBeNull();
      expect(typeof firstBody.revision).toBe("string");

      const second = await postMeta(ctx, "doc.html", {
        addTags: ["一", "三"],
        sourceUrl: "https://example.com",
      });
      const secondBody = jsonBodyOf(second) as WireMetaWrite;
      expect(secondBody.tags).toEqual(["一", "二", "三"]);
      expect(secondBody.sourceUrl).toBe("https://example.com/");
      // Provenance stays first-write facts.
      expect(secondBody.savedAt).toBe(firstBody.savedAt);

      const cleared = await postMeta(ctx, "doc.html", {
        removeTags: ["二"],
        sourceUrl: null,
      });
      const clearedBody = jsonBodyOf(cleared) as WireMetaWrite;
      expect(clearedBody.tags).toEqual(["一", "三"]);
      expect(clearedBody.sourceUrl).toBeNull();

      // The document's own bytes never move.
      const after = fileStateOf(ctx.file);
      expect(after.bytes.equals(before.bytes)).toBe(true);
    }, defaultSeed);
  });

  it("should round-trip through GET", async () => {
    await withServer(async (ctx) => {
      await postMeta(ctx, "doc.html", { tags: ["读"], sourceUrl: "https://r.test" });

      const body = jsonBodyOf(await getMeta(ctx, "doc.html")) as WireMeta;
      expect(body.tags).toEqual(["读"]);
      expect(body.sourceUrl).toBe("https://r.test/");
      expect(body.createdBy).toBe("user");
    }, defaultSeed);
  });

  it("should report changed:false when the patch reproduces the record", async () => {
    await withServer(async (ctx) => {
      await postMeta(ctx, "doc.html", { tags: ["x"] });
      const response = await postMeta(ctx, "doc.html", { tags: ["x"] });

      expect((jsonBodyOf(response) as WireMetaWrite).changed).toBe(false);
    }, defaultSeed);
  });

  it("should keep the table's other docs when writing one doc", async () => {
    await withServer(async (ctx) => {
      await postMeta(ctx, "doc.html", { tags: ["a"] });
      await postMeta(ctx, "other.html", { tags: ["b"] });

      expect((jsonBodyOf(await getMeta(ctx, "doc.html")) as WireMeta).tags).toEqual(["a"]);
      expect((jsonBodyOf(await getMeta(ctx, "other.html")) as WireMeta).tags).toEqual(["b"]);
    }, defaultSeed);
  });
});

describe("meta routes · corrupt table", () => {
  it("should report the corrupt diagnostic on read and heal on the next write", async () => {
    await withServer(async (ctx) => {
      mkdirSync(join(ctx.workspace, ".hreader"), { recursive: true });
      writeFileSync(tablePath(ctx), "{broken");

      const read = jsonBodyOf(await getMeta(ctx, "doc.html")) as WireMeta;
      expect(read.tags).toEqual([]);
      expect(read.diagnostics).toEqual(["doc_meta_corrupt:not_object"]);

      const written = await postMeta(ctx, "doc.html", { tags: ["healed"] });
      expect((jsonBodyOf(written) as WireMetaWrite).tags).toEqual(["healed"]);
      const names = readFileSync(tablePath(ctx), "utf8");
      expect(names).toContain('"healed"');
    }, defaultSeed);
  });
});

describe("meta routes · SSE", () => {
  it("should broadcast doc.meta once per successful write and stay silent on failures", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      try {
        await sse.waitForEvent("ready");

        const written = await postMeta(ctx, "doc.html", { tags: ["x"] });
        expect(written.status).toBe(200);
        const first = await sse.waitForEvent("doc.meta");
        expect(first.data).toContain('"docId":"doc.html"');

        // A no-op write answers 200 changed:false but must not broadcast — only real
        // changes fire doc.meta.
        const noop = await postMeta(ctx, "doc.html", { tags: ["x"] });
        expect(noop.status).toBe(200);
        expect((jsonBodyOf(noop) as WireMetaWrite).changed).toBe(false);

        const failures = await Promise.all([
          postMeta(ctx, "doc.html", { bogus: 1 }),
          postMeta(ctx, "doc.html", { sourceUrl: "javascript:x" }),
          postMeta(ctx, "missing.html", { tags: ["x"] }),
        ]);
        for (const failure of failures) expect(failure.status).toBeGreaterThanOrEqual(400);

        const second = await postMeta(ctx, "doc.html", { addTags: ["y"] });
        expect(second.status).toBe(200);

        // ready + two doc.meta — then a beat so a wrongly-published no-op frame lands too.
        await sse.waitFor(3);
        await settle(300);
        const events = sse.frames.filter((frame) => frame.event === "doc.meta");
        expect(events).toHaveLength(2);
        // A meta write never fires doc.changed — the document bytes are untouched.
        expect(sse.frames.some((frame) => frame.event === "doc.changed")).toBe(false);
      } finally {
        sse.close();
      }
    }, defaultSeed);
  });
});

describe("meta routes · concurrency", () => {
  it("should land every tag of N parallel writes exactly once", async () => {
    await withServer(async (ctx) => {
      const n = 8;
      const responses = await Promise.all(
        Array.from({ length: n }, (_u, index) =>
          postMeta(ctx, "doc.html", { addTags: [`w${String(index)}`] }),
        ),
      );
      for (const response of responses) expect(response.status).toBe(200);

      const body = jsonBodyOf(await getMeta(ctx, "doc.html")) as WireMeta;
      expect(body.tags).toHaveLength(n);
      expect(new Set(body.tags).size).toBe(n);
    }, defaultSeed);
  });
});
