// 这层管：`POST /api/doc/:docId/normalize`——normalizable 一键托管（留快照可 undo）、
// managed no-op、foreign 422、csrf 门禁与并发写串行。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, defaultSeed, httpCall, jsonBodyOf, openSse, withServer } from "./harness";
import { withPost } from "./wire";

const NORMALIZABLE = "<article><p>没有 id</p></article>";

const FOREIGN = '<!doctype html><html><body><div class="app">plain</div></body></html>';
const FOREIGN_MULTI = "<article><p>a</p></article><article><p>b</p></article>";

const seedWith =
  (html: string) =>
  (workspace: string): void => {
    defaultSeed(workspace);
    writeFileSync(join(workspace, "doc.html"), html, "utf8");
  };

const postNormalize = (
  port: number,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> =>
  httpCall(port, {
    method: "POST",
    path: "/api/doc/doc.html/normalize",
    headers: withPost(token),
    body: "{}",
  }).then((response) => ({
    status: response.status,
    body: jsonBodyOf(response) as Record<string, unknown>,
  }));

describe("doc normalize · normalizable", () => {
  it("should inject ids, answer cls managed, and publish doc.changed", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const { status, body } = await postNormalize(ctx.port, ctx.token);
      const frame = await sse.waitForEvent("doc.changed");
      sse.close();

      expect(status).toBe(200);
      expect(body).toMatchObject({ cls: "managed" });
      expect(body["revision"]).toMatch(/^[0-9a-f]{16}$/u);
      expect(frame.data).toContain('"docId":"doc.html"');
      expect(frame.data).toContain('"changedNodes":[]');
      const html = readFileSync(ctx.file, "utf8");
      expect(html).toContain('data-hr-id="');
      const info = jsonBodyOf(
        await httpCall(ctx.port, {
          path: "/api/doc/doc.html/info",
          headers: { cookie: cookieOf(ctx.token) },
        }),
      );
      expect(info).toMatchObject({ cls: "managed" });
    }, seedWith(NORMALIZABLE));
  });

  it("should leave a snapshot so undo restores the pre-normalize bytes", async () => {
    await withServer(async (ctx) => {
      await postNormalize(ctx.port, ctx.token);
      const undone = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/undo",
        headers: withPost(ctx.token),
        body: "{}",
      });

      expect(undone.status).toBe(200);
      expect(readFileSync(ctx.file, "utf8")).not.toContain("data-hr-id");
      const info = jsonBodyOf(
        await httpCall(ctx.port, {
          path: "/api/doc/doc.html/info",
          headers: { cookie: cookieOf(ctx.token) },
        }),
      );
      expect(info).toMatchObject({ cls: "normalizable" });
    }, seedWith(NORMALIZABLE));
  });

  it("should serialize parallel normalize calls: one snapshot, one undo back", async () => {
    await withServer(async (ctx) => {
      const results = await Promise.all(
        Array.from({ length: 5 }, async () => await postNormalize(ctx.port, ctx.token)),
      );

      expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200]);
      const html = readFileSync(ctx.file, "utf8");
      const ids = [...html.matchAll(/data-hr-id="([^"]+)"|data-hr-id='([^']+)'/gu)].map(
        (match) => match[1] ?? match[2],
      );
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);

      const undone = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/undo",
        headers: withPost(ctx.token),
        body: "{}",
      });
      expect(undone.status).toBe(200);
      expect(readFileSync(ctx.file, "utf8")).toBe(NORMALIZABLE);
    }, seedWith(NORMALIZABLE));
  });
});

describe("doc normalize · managed", () => {
  it("should answer 200 cls managed without touching the file", async () => {
    await withServer(async (ctx) => {
      const before = readFileSync(ctx.file, "utf8");
      const { status, body } = await postNormalize(ctx.port, ctx.token);

      expect(status).toBe(200);
      expect(body).toMatchObject({ cls: "managed" });
      expect(readFileSync(ctx.file, "utf8")).toBe(before);
    });
  });
});

describe("doc normalize · foreign", () => {
  it("should answer 422 invalid_document when there is no article", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await postNormalize(ctx.port, ctx.token);

      expect(status).toBe(422);
      expect(body).toMatchObject({ code: "invalid_document" });
      expect(body["message"]).toContain("<article>");
    }, seedWith(FOREIGN));
  });

  it("should answer 422 invalid_document when there are multiple articles", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await postNormalize(ctx.port, ctx.token);

      expect(status).toBe(422);
      expect(body).toMatchObject({ code: "invalid_document" });
      expect(readFileSync(ctx.file, "utf8")).toBe(FOREIGN_MULTI);
    }, seedWith(FOREIGN_MULTI));
  });
});

describe("doc normalize · 鉴权", () => {
  it("should answer 403 without the csrf header", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/normalize",
        headers: { cookie: cookieOf(ctx.token), "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(403);
      expect(jsonBodyOf(response)).toMatchObject({ code: "forbidden_origin" });
      expect(readFileSync(ctx.file, "utf8")).toBe(NORMALIZABLE);
    }, seedWith(NORMALIZABLE));
  });
});
