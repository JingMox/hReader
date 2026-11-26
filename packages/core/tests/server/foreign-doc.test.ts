// 这层管：外来文档（无 / 多 <article>）——`hr serve` 能起来、`/s/` 302 进 `/f/` 照出 HTML、
// model/outline 仍 422、变更照推 doc.changed。

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, docPageOf, httpCall, jsonBodyOf, openSse, withServer } from "./harness";

const FOREIGN = [
  "<!doctype html>",
  "<html><head><title>anim</title><script>const go=()=>requestAnimationFrame(go)</script></head>",
  '<body><div class="app">外来内容<script>go()</script></div></body></html>',
].join("\r\n");

const foreignSeed = (workspace: string): void => {
  writeFileSync(join(workspace, "doc.html"), FOREIGN, "utf8");
};

describe("foreign doc · 启动", () => {
  it("should start and answer /healthz when docId is a foreign document", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/healthz" });

      expect(response.status).toBe(200);
      expect(jsonBodyOf(response)).toMatchObject({ ok: true });
    }, foreignSeed);
  });

  it("should 302 /s/ into the capability-gated /f/ page with the off-trust CSP", async () => {
    await withServer(async (ctx) => {
      const entry = await httpCall(ctx.port, {
        path: "/s/doc.html",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(entry.status).toBe(302);
      expect(entry.headers["location"]).toMatch(/^\/f\/[A-Za-z0-9_-]{22}\/doc\.html$/u);

      const response = await docPageOf(ctx.port, ctx.token, "doc.html");
      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; font-src 'self'; media-src 'self'; " +
          "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox",
      );
      expect(response.body).toContain("外来内容");
    }, foreignSeed);
  });
});

describe("foreign doc · 冻结读面", () => {
  it("should keep /api/model at 422 invalid_document for a foreign doc", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(422);
      expect(jsonBodyOf(response)).toMatchObject({ code: "invalid_document" });
    }, foreignSeed);
  });

  it("should keep /api/outline at 422 invalid_document for a foreign doc", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/outline",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(422);
      expect(jsonBodyOf(response)).toMatchObject({ code: "invalid_document" });
    }, foreignSeed);
  });

  it("should keep /api/outline at 409 needs_normalize for a normalizable doc", async () => {
    await withServer(
      async (ctx) => {
        const response = await httpCall(ctx.port, {
          path: "/api/doc/doc.html/outline",
          headers: { cookie: cookieOf(ctx.token) },
        });

        expect(response.status).toBe(409);
        expect(jsonBodyOf(response)).toMatchObject({ code: "needs_normalize" });
      },
      (workspace) => {
        writeFileSync(join(workspace, "doc.html"), "<article><p>没有 id</p></article>", "utf8");
      },
    );
  });
});

describe("foreign doc · SSE", () => {
  it("should publish doc.changed with empty changedNodes when the foreign file changes", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      writeFileSync(ctx.file, `${FOREIGN}\r\n<!-- v2 -->`, "utf8");
      const frame = await sse.waitForEvent("doc.changed");
      sse.close();

      expect(frame.data).toContain('"changedNodes":[]');
      expect(frame.data).toContain('"docId":"doc.html"');
      expect(sse.frames.some((item) => item.event === "doc.error")).toBe(false);
    }, foreignSeed);
  });

  it("should publish doc.changed with empty changedNodes when a managed doc turns foreign", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      writeFileSync(ctx.file, FOREIGN, "utf8");
      const frame = await sse.waitForEvent("doc.changed");
      sse.close();

      expect(frame.data).toContain('"changedNodes":[]');
    });
  });
});
