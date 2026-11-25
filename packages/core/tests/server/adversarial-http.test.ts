// 这层管：HTTP 形状对抗——畸形 body、大小边界、方法面、重复 query、
// 鉴权参数错位置（?t= 只在 token 路由上有效）。

import { describe, expect, it } from "vitest";

import { cookieOf, httpCall, jsonBodyOf, rawExchange, withServer } from "./harness";
import { rawRequest, withCookie, withPost } from "./wire";

const appendBody = (): string =>
  JSON.stringify({ docId: "doc.html", action: "append", targetId: "hr-d", fragment: "<b>t</b>" });

describe("body · 形状", () => {
  it.each([
    { name: "truncated JSON", body: `{"docId":` },
    { name: "a JSON array", body: `[1,2]` },
    { name: "JSON null", body: `null` },
    { name: "a bare string", body: `"x"` },
    { name: "a bare number", body: `42` },
    { name: "empty object", body: `{}` },
  ])("should answer 400 invalid_request for $name on /api/patch", async ({ body }) => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body,
      });

      expect(response.status).toBe(400);
      expect(jsonBodyOf(response)).toMatchObject({ code: "invalid_request" });
    });
  });

  it("should ignore Content-Type: the body contract is JSON-by-content", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: { ...withPost(ctx.token), "Content-Type": "text/plain" },
        body: appendBody(),
      });

      expect(response.status).toBe(200);
    });
  });

  it("should pass a body at exactly 1 MiB to the JSON layer and 413 above it", async () => {
    await withServer(async (ctx) => {
      const pad = "x".repeat(1_048_576);
      const at = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body: pad,
        listen: 20_000,
      });
      const over = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body: `${pad}x`,
        listen: 20_000,
      });

      // 边界内：字节数过关才轮到 JSON 解析 → 400 invalid_request；
      // 越界：413，连 JSON 都不看。
      expect(at.status).toBe(400);
      expect(over.status).toBe(413);
    });
  });

  it("should 413 a chunked body over the limit (no Content-Length to consult)", async () => {
    await withServer(async (ctx) => {
      const chunk = `${(1_048_577).toString(16)}\r\n${"x".repeat(1_048_577)}\r\n`;
      const raw = await rawExchange(
        ctx.port,
        `POST /api/patch HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nX-HR-CSRF: 1\r\nTransfer-Encoding: chunked\r\n\r\n${chunk}0\r\n\r\n`,
        "HTTP/1.1",
      );

      expect(raw).toContain("413");
    });
  });
});

describe("method · 面", () => {
  it.each([
    { method: "HEAD", path: "/healthz", allow: "GET" },
    { method: "OPTIONS", path: "/healthz", allow: "GET" },
    { method: "DELETE", path: "/api/doc/doc.html/model", allow: "GET" },
    { method: "PUT", path: "/api/patch", allow: "POST" },
  ])("should 405 $method $path with Allow: $allow", async ({ method, path, allow }) => {
    await withServer(async (ctx) => {
      const raw = await rawExchange(
        ctx.port,
        rawRequest(ctx.port, {
          method,
          path,
          headers: withCookie(ctx.token),
        }),
        "HTTP/1.1",
      );

      expect(raw).toContain("405");
      expect(raw.toLowerCase()).toContain(`allow: ${allow.toLowerCase()}`);
    });
  });

  it("should answer 404 for OPTIONS * (no route owns the asterisk)", async () => {
    await withServer(async (ctx) => {
      const raw = await rawExchange(
        ctx.port,
        `OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\n\r\n`,
        "HTTP/1.1",
      );

      expect(raw).toContain("404");
    });
  });
});

describe("query · 重复与错位", () => {
  it("should honor the first ?t= and reject a forged one that precedes the real one", async () => {
    await withServer(async (ctx) => {
      const real = await httpCall(ctx.port, {
        path: `/s/doc.html?t=${encodeURIComponent(ctx.token)}&t=forged`,
      });
      const forged = await httpCall(ctx.port, {
        path: `/s/doc.html?t=forged&t=${encodeURIComponent(ctx.token)}`,
      });

      expect(real.status).toBe(302);
      expect(forged.status).toBe(401);
    });
  });

  it("should ignore ?t= on write routes: cookie+csrf is the only shape there", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: `/api/patch?t=${encodeURIComponent(ctx.token)}`,
        headers: withPost(ctx.token),
        body: appendBody(),
      });

      // 200 还是 401？cookie+csrf 都齐了 → 200；?t= 不参与这条路线的鉴权。
      expect(response.status).toBe(200);
    });
  });

  it("should 401 a write route that only has ?t= and no cookie", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: `/api/patch?t=${encodeURIComponent(ctx.token)}`,
        headers: { "X-HR-CSRF": "1", "Content-Type": "application/json" },
        body: appendBody(),
      });

      expect(response.status).toBe(401);
    });
  });

  it("should ignore duplicate non-auth query params on API routes", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model?x=1&x=2",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(200);
    });
  });
});

describe("wire · 其它形状", () => {
  it("should serve an absolute-form request-target like origin-form", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: `http://127.0.0.1:${String(ctx.port)}/healthz`,
      });

      expect(response.status).toBe(200);
    });
  });

  it("should read only the first hr= cookie when the header carries two", async () => {
    await withServer(async (ctx) => {
      const badFirst = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: `hr=forged; hr=${ctx.token}` },
      });
      const goodFirst = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: `hr=${ctx.token}; hr=forged` },
      });

      expect(badFirst.status).toBe(401);
      expect(goodFirst.status).toBe(200);
    });
  });
});
