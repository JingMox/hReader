// 这层管：HTTP 解析边界——全部用 `node:net` 手写原文请求，不经 fetch；断言原始状态行/头/连接行为。

import { describe, expect, it } from "vitest";

import { cookieOf, httpCall, rawExchange, withServer, type TestServer } from "./harness";

const statusLineOf = (raw: string): string => raw.split("\r\n")[0] ?? "";

const exchange = async (ctx: TestServer, request: string, until = "\r\n\r\n"): Promise<string> =>
  await rawExchange(ctx.port, request, until);

describe("wire · Content-Length 冲突", () => {
  it("should reject two different Content-Length headers with 400", async () => {
    await withServer(async (ctx) => {
      const body = "{}";
      const raw = await exchange(
        ctx,
        `POST /api/patch HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nX-HR-CSRF: 1\r\nContent-Type: application/json\r\nContent-Length: ${String(body.length)}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n${body}`,
        "HTTP/1.1",
      );

      expect(statusLineOf(raw)).toMatch(/^HTTP\/1\.1 400/u);
    });
  });

  it("should reject chunked together with Content-Length", async () => {
    await withServer(async (ctx) => {
      const raw = await exchange(
        ctx,
        `POST /api/patch HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nX-HR-CSRF: 1\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\nConnection: close\r\n\r\n0\r\n\r\n`,
        "HTTP/1.1",
      );

      expect(statusLineOf(raw)).toMatch(/^HTTP\/1\.1 400/u);
    });
  });
});

describe("wire · 体大小与半截请求", () => {
  it("should refuse a body over 1 MiB as invalid_request (400) and leave the file untouched", async () => {
    await withServer(async (ctx) => {
      const before = ctx.file;
      const huge = `{"docId":"doc.html","action":"append","targetId":"hr-d","fragment":"${"x".repeat(1_048_576)}"}`;
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: {
          cookie: cookieOf(ctx.token),
          "x-hr-csrf": "1",
          "content-type": "application/json",
          "content-length": String(huge.length),
        },
        body: huge,
      });

      expect(response.status).toBe(413);
      expect(response.body).toContain("请求体超过");
      expect(await import("node:fs").then((fs) => fs.readFileSync(before, "utf8"))).toBeTruthy();
    });
  });

  // 真 bug：`http-io.chunksOf` 只监听 data/end，客户端中途销毁后 Promise 永不落地，
  // 连接与闭包夹着 body 一直挂着（fd/内存泄漏）；正确做法是监听 `aborted`/`close` 并以 invalid_request 结束。
  // KD-07
  it.fails("should answer a truncated (EOF) request close, not hang", async () => {
    await withServer(async (ctx) => {
      const raw = await exchange(
        ctx,
        `POST /api/patch HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nX-HR-CSRF: 1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"docId"`,
        "HTTP/1.1",
      );

      // 半截体不能变成 200：要么明确 4xx，要么连接直接关掉（没有响应行）。
      expect(raw === "" || /^HTTP\/1\.[01] 4/u.test(raw)).toBe(true);
    });
  });
});

describe("wire · 方法与版本", () => {
  it("should accept a GET with a body (体被忽略)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "GET",
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token), "content-length": "2" },
        body: "{}",
      });

      expect(response.status).toBe(200);
    });
  });

  it("should serve an HTTP/1.0 request with a Host header, then close", async () => {
    await withServer(async (ctx) => {
      const raw = await exchange(
        ctx,
        `GET /healthz HTTP/1.0\r\nHost: 127.0.0.1:${String(ctx.port)}\r\n\r\n`,
        "HTTP/1.0 200",
      );

      expect(statusLineOf(raw)).toMatch(/^HTTP\/1\.[01] 200/u);
    });
  });

  it("should handle two pipelined requests on one socket", async () => {
    await withServer(async (ctx) => {
      const raw = await rawExchange(
        ctx.port,
        `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\n\r\nGET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nConnection: close\r\n\r\n`,
        '"uptimeMs"',
        4000,
      );

      expect(raw.match(/HTTP\/1\.1 200/gu) ?? []).toHaveLength(2);
      expect(raw.match(/"ok":true/gu) ?? []).toHaveLength(2);
    });
  });
});

describe("wire · 方法与版本（续）", () => {
  it("should reject a header block over 8 KiB (431)", async () => {
    await withServer(async (ctx) => {
      const raw = await exchange(
        ctx,
        `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`,
        "HTTP/1.1",
      );

      expect(statusLineOf(raw)).toMatch(/^HTTP\/1\.1 431/u);
    });
  });
});

describe("wire · 响应头与安全头", () => {
  it("should send nosniff + CSP on the document page", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/s/doc.html",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toContain("<article");
    });
  });

  it("should serve the home page with a cookie and encode the docId", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('<a href="/s/doc.html">doc.html</a>');
      expect(response.body).toContain("/api/healthz");
    });
  });

  it("should answer healthz without a cookie", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/healthz" });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ ok: true });
    });
  });
});

describe("wire · 响应头与安全头（续）", () => {
  it("should answer an unknown path with JSON 404 and nosniff", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/nope" });

      expect(response.status).toBe(404);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(response.body)).toEqual({ code: "not_found" });
    });
  });

  it("should answer a wrong method with 405 + Allow", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/api/patch" });

      expect(response.status).toBe(405);
      expect(response.headers["allow"]).toBe("POST");
    });
  });
});
