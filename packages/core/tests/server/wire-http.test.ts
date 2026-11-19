// 这层管：HTTP 解析边界——全部用 `node:net` 手写原文请求，不经 fetch；断言原始状态行/头/连接行为。

import { connect, type Socket } from "node:net";
import { describe, expect, it } from "vitest";

import { cookieOf, httpCall, rawExchange, withServer, type TestServer } from "./harness";

const statusLineOf = (raw: string): string => raw.split("\r\n")[0] ?? "";

/** 写完半截请求后**半关**写端（`end()` 而非 `destroy()`：只发 FIN，仍能读响应）。 */
const halfClosedExchange = (port: number, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const raw = (): string => Buffer.concat(chunks).toString("latin1");
    const socket: Socket = connect({ host: "127.0.0.1", port });
    const settle = (action: () => void): void => {
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`半截请求 1500ms 内没有任何响应字节；raw=${JSON.stringify(raw())}`));
    }, 1500);
    socket.on("connect", () => socket.end(text, "latin1"));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      settle(() => {
        resolve(raw());
      });
    });
    socket.on("error", (error: Error) => {
      settle(() => {
        // 服务端写完 400 就 `destroy()`，接收缓冲里剩的请求体可能触发 RST：状态行已经在手就该按「半截响应」收尾，
        // 否则把裸 `ECONNRESET` 当结果，失败文本说不出机制。
        if (/^HTTP\/1\.[01] /u.test(raw())) resolve(raw());
        else
          reject(new Error(`半截请求：socket 错误 ${error.message}；raw=${JSON.stringify(raw())}`));
      });
    });
  });

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
});

describe("wire · 半截请求（KD-07 记账）", () => {
  // KD-07 记账（旧注释「只监听 data/end、Promise 永不落地」已过期）：线上真行为是**裸 400，不是 408**——
  // ① 客户端半关（FIN）后，Node 内置 parser 先报 `HPE_INVALID_EOF_STATE`（`clientError` 的 Parse Error），
  //    默认 clientError 直接把 `HTTP/1.1 400 Bad Request` 写死并 destroy socket；`server.ts` 没有
  //    `clientError` 监听，所以 `chunksOf` 的 `aborted` ⇒ `HttpFault(408, "连接在请求体读完前断开")` 抢不到响应。
  // ② 所以那条 10s 的 `408 请求体读取超时` 只对「客户端保持连接不发 FIN」成立，和本用例不是一条路径。
  // ③ 断言只锚「400 + 快」：它测的是「不挂死」；将来若把 `clientError` 映射成 JSON 错误体，本用例仍应绿。
  it("should answer a truncated (EOF) request close fast instead of hanging", async () => {
    await withServer(async (ctx) => {
      const started = Date.now();
      const raw = await halfClosedExchange(
        ctx.port,
        `POST /api/patch HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nX-HR-CSRF: 1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"docId"`,
      );
      const elapsed = Date.now() - started;

      expect(statusLineOf(raw)).toMatch(/^HTTP\/1\.1 400/u);
      // 耗时才是杀「用 10s/4s 墙钟冒充判据」的真判据：实测 ~3ms。
      expect(elapsed).toBeLessThan(1000);
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
      expect(response.body).toContain('<a href="/healthz">healthz</a>');
      expect(response.body).not.toContain("/api/healthz");
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
