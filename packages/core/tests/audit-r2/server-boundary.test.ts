// 第二轮对抗：HTTP 边界的变体面——第一轮已钉 ?t= 首值、method 大小写、重复 cookie、
// allow-host、.hreader、../、%2F、dotfile。本轮专打**当时没钉住的等价形态**：
// loopback 的其它拼写（FQDN 尾点/缩写 IPv4/IPv6/0.0.0.0——全是 DNS rebinding 的常见皮）、
// Origin 的更多形态、Set-Cookie 属性、CSRF 头变体、NUL/超长名、符号链接逃逸、
// SSE 的 Origin 闸与断连存活。

import { writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cookieOf,
  httpCall,
  jsonBodyOf,
  openSse,
  rawExchange,
  withServer,
} from "../server/harness";

const host = (port: number): string => `127.0.0.1:${String(port)}`;

const getDoc = (port: number, headers: Readonly<Record<string, string>>): Promise<string> =>
  rawExchange(
    port,
    `GET /healthz HTTP/1.1\r\n${Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n")}\r\n\r\n`,
    "HTTP/1.1",
  );

describe("host · loopback 的等价拼写一律 403", () => {
  it.each([
    "127.0.0.1.", // 尾点 FQDN：DNS 照样解析回环
    "localhost.",
    "0.0.0.0", // 连得上（INADDR_ANY 语义）但不是合法 Host
    "127.1", // 缩写 IPv4
    "127.0.1.1",
    "2130706433", // 127.0.0.1 的十进制
    "0x7f000001",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[0:0:0:0:0:ffff:7f00:1]",
  ])("should 403 Host: %s:<port>", async (base) => {
    await withServer(async (ctx) => {
      const raw = await getDoc(ctx.port, { Host: `${base}:${String(ctx.port)}` });
      expect(raw).toContain("403");
      expect(raw).toContain("forbidden_origin");
    });
  });

  it.each(["127.0.0.1", "localhost"])("should serve Host: %s:<port>", async (base) => {
    await withServer(async (ctx) => {
      const raw = await getDoc(ctx.port, { Host: `${base}:${String(ctx.port)}` });
      expect(raw).toContain("200");
    });
  });

  it("should 400 a duplicate Host even when both copies are valid", async () => {
    await withServer(async (ctx) => {
      const raw = await rawExchange(
        ctx.port,
        `GET /healthz HTTP/1.1\r\nHost: ${host(ctx.port)}\r\nHost: ${host(ctx.port)}\r\n\r\n`,
        "HTTP/1.1",
      );
      expect(raw).toContain("400");
    });
  });

  it("should ignore X-Forwarded-Host / Forwarded entirely", async () => {
    await withServer(async (ctx) => {
      const raw = await getDoc(ctx.port, {
        Host: host(ctx.port),
        "X-Forwarded-Host": "evil.example",
        Forwarded: "host=evil.example",
      });
      expect(raw).toContain("200");
    });
  });
});

describe("origin · 跨源形态", () => {
  const withOrigin = async (
    ctx: { port: number; token: string },
    origin: string,
  ): Promise<string> =>
    rawExchange(
      ctx.port,
      `GET /api/events HTTP/1.1\r\nHost: ${host(ctx.port)}\r\nOrigin: ${origin}\r\nCookie: ${cookieOf(ctx.token)}\r\n\r\n`,
      "HTTP/1.1",
    );

  it.each([
    "http://127.0.0.1", // 无端口：origin 必带端口（非默认）
    "https://127.0.0.1:PORT", // 本服务没有 TLS
    "http://0.0.0.0:PORT",
    "http://127.1:PORT",
    "http://[::1]:PORT",
    "http://127.0.0.1:PORT.evil.example",
    "http://evil.example@127.0.0.1:PORT",
    "null", // 沙箱 opaque origin / file:// 页发来的都是这个
    "file://",
    "http://127.0.0.1:PORT/path", // origin 从不带 path
  ])("should 403 Origin: %s on SSE subscribe", async (template) => {
    await withServer(async (ctx) => {
      const raw = await withOrigin(ctx, template.replaceAll("PORT", String(ctx.port)));
      expect(raw).toContain("403");
      expect(raw).toContain("forbidden_origin");
    });
  });

  it("should gate Origin before route dispatch: /healthz also 403s", async () => {
    await withServer(async (ctx) => {
      const raw = await getDoc(ctx.port, {
        Host: host(ctx.port),
        Origin: "http://evil.example",
      });
      expect(raw).toContain("403");
    });
  });

  it("should allow the loopback Origin (same-origin reader app fetches)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/healthz",
        headers: { origin: `http://${host(ctx.port)}` },
      });
      expect(response.status).toBe(200);
    });
  });
});

describe("token · 重定向与 cookie", () => {
  it("should 302 /?t= to bare /, set HttpOnly+SameSite=Strict cookie, and not echo the token", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: `/?t=${ctx.token}` });
      expect(response.status).toBe(302);
      expect(response.headers["location"]).toBe("/");
      const cookie = String(response.headers["set-cookie"]);
      expect(cookie).toContain(`hr=${ctx.token}`);
      expect(cookie.toLowerCase()).toContain("httponly");
      expect(cookie.toLowerCase()).toContain("samesite=strict");
      // token 绝不许出现在 location/set-cookie 之外的任何头里（Referer 面在浏览器侧由 302 天然清掉）。
      for (const [name, value] of Object.entries(response.headers)) {
        if (name === "set-cookie") continue;
        expect(String(value)).not.toContain(ctx.token);
      }
    });
  });

  it("should accept ?token= as the alias and redirect the same way", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: `/?token=${ctx.token}` });
      expect(response.status).toBe(302);
      expect(response.headers["location"]).toBe("/");
    });
  });

  it("should strip the whole query on redirect: other params do not survive", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: `/?doc=a&t=${ctx.token}` });
      expect(response.status).toBe(302);
      expect(response.headers["location"]).toBe("/");
    });
  });

  it("should 302 /s/<doc>?t= to the bare doc path", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: `/s/doc.html?t=${ctx.token}` });
      expect(response.status).toBe(302);
      expect(response.headers["location"]).toBe("/s/doc.html");
    });
  });

  it("should 401 ?t= on cookie-only routes and never set a cookie", async () => {
    await withServer(async (ctx) => {
      for (const path of ["/api/events", "/api/doc/doc.html/info"]) {
        const response = await httpCall(ctx.port, { path: `${path}?t=${ctx.token}` });
        expect(response.status).toBe(401);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
    });
  });

  it("should 401 a wrong token on /s/ without setting a cookie", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/s/doc.html?t=definitely-wrong" });
      expect(response.status).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
    });
  });
});

const patchBody = (): string =>
  JSON.stringify({
    docId: "doc.html",
    action: "append",
    targetId: "hr-d",
    fragment: "<b>x</b>",
  });

describe("csrf · 写面", () => {
  it.each(["0", "yes", "2", "true"])(
    "should 403 x-hr-csrf: %s even with a valid cookie",
    async (value) => {
      await withServer(async (ctx) => {
        const response = await httpCall(ctx.port, {
          method: "POST",
          path: "/api/patch",
          headers: { cookie: cookieOf(ctx.token), "x-hr-csrf": value },
          body: patchBody(),
        });
        expect(response.status).toBe(403);
      });
    },
  );

  it.each([" 1", "1 ", " 1 "])(
    "should accept x-hr-csrf with RFC optional whitespace: %s (node trims headers)",
    async (value) => {
      await withServer(async (ctx) => {
        const response = await httpCall(ctx.port, {
          method: "POST",
          path: "/api/patch",
          headers: { cookie: cookieOf(ctx.token), "x-hr-csrf": value },
          body: patchBody(),
        });
        expect(response.status).toBe(200);
      });
    },
  );

  it("should 403 a doubled x-hr-csrf (node joins duplicates into '1, 0')", async () => {
    await withServer(async (ctx) => {
      const raw = await rawExchange(
        ctx.port,
        `POST /api/patch HTTP/1.1\r\nHost: ${host(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nx-hr-csrf: 1\r\nx-hr-csrf: 0\r\nContent-Length: ${String(patchBody().length)}\r\n\r\n${patchBody()}`,
        "HTTP/1.1",
      );
      expect(raw).toContain("403");
    });
  });

  it("should 403 a fully-authed write carrying a hostile Origin (foreign page CSRF)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: {
          cookie: cookieOf(ctx.token),
          "x-hr-csrf": "1",
          origin: "http://evil.example",
        },
        body: patchBody(),
      });
      expect(response.status).toBe(403);
      expect(jsonBodyOf(response)).toMatchObject({ code: "forbidden_origin" });
    });
  });
});

describe("docId · NUL / 超长 / 符号链接", () => {
  it("should 400 a NUL docId on /s/ before any fs call", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/s/%00",
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(response.status).toBe(400);
      expect(jsonBodyOf(response)).toMatchObject({ code: "invalid_request" });
    });
  });

  it("should 400 a NUL docId in a write body (same resolveTarget gate)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: { cookie: cookieOf(ctx.token), "x-hr-csrf": "1" },
        body: JSON.stringify({
          docId: "a\0b",
          action: "append",
          targetId: "hr-d",
          fragment: "<b>x</b>",
        }),
      });
      expect(response.status).toBe(400);
      expect(jsonBodyOf(response)).toMatchObject({ code: "invalid_request" });
    });
  });

  it("should 404 (not_a_file) an ENAMETOOLONG docId instead of leaking a 500", async () => {
    await withServer(async (ctx) => {
      const long = `${"a".repeat(300)}.html`;
      const response = await httpCall(ctx.port, {
        path: `/s/${long}`,
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(response.status).toBe(404);
      expect(jsonBodyOf(response)).toMatchObject({ code: "not_a_file" });
    });
  });

  it("should 403 a doc reached through a symlinked directory that leaves the workspace", async () => {
    await withServer(async (ctx) => {
      const outside = join(ctx.home, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "leak.html"), "<p>机密</p>", "utf8");
      symlinkSync(outside, join(ctx.workspace, "link"), "dir");
      const response = await httpCall(ctx.port, {
        path: "/s/link/leak.html",
        headers: { cookie: cookieOf(ctx.token) },
      });
      // 目录符号链接走 not_a_file(404)、文件符号链接走 path_outside_workspace(403)：
      // 两条都拦在服务边界外——钉住"绝不 200"即可，具体码属实现细节。
      expect([403, 404]).toContain(response.status);
      expect(response.body).not.toContain("机密");
    });
  });

  it("should 403 a symlinked file whose target leaves the workspace", async () => {
    await withServer(async (ctx) => {
      const outside = join(ctx.home, "secret.html");
      writeFileSync(outside, "<p>机密</p>", "utf8");
      symlinkSync(outside, join(ctx.workspace, "alias.html"), "file");
      const response = await httpCall(ctx.port, {
        path: "/s/alias.html",
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(response.status).toBe(403);
      expect(jsonBodyOf(response)).toMatchObject({ code: "path_outside_workspace" });
    });
  });

  it("should still serve a symlink that resolves inside the workspace", async () => {
    await withServer(async (ctx) => {
      symlinkSync(join(ctx.workspace, "doc.html"), join(ctx.workspace, "inner.html"), "file");
      const response = await httpCall(ctx.port, {
        path: "/s/inner.html",
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(response.status).toBe(200);
    });
  });
});

describe("sse · 订阅闸与断连存活", () => {
  it("should 403 an SSE subscribe carrying a hostile Origin (cross-origin EventSource)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/events",
        headers: {
          cookie: cookieOf(ctx.token),
          origin: "http://evil.example",
        },
      });
      expect(response.status).toBe(403);
      expect(jsonBodyOf(response)).toMatchObject({ code: "forbidden_origin" });
    });
  });

  it("should survive an SSE client that vanishes mid-stream (no unhandled error crash)", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { cookie: cookieOf(ctx.token) });
      await sse.waitForEvent("ready");
      // 断开（内部 socket.destroy）：服务端下一次 publish 会写进死 socket。
      sse.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: { cookie: cookieOf(ctx.token), "x-hr-csrf": "1" },
        body: patchBody(),
      });
      // 服务端必须活着并完成这次写（写会触发 doc.changed → 向死 socket publish）。
      expect(response.status).toBe(200);
      const health = await httpCall(ctx.port, { path: "/healthz" });
      expect(health.status).toBe(200);
    });
  });
});

describe("foreign · 写入口的 derive gate", () => {
  const FOREIGN = [
    "<!doctype html>",
    "<html><head><title>x</title><script>console.log(1)</script></head>",
    "<body><div>外来内容</div></body></html>",
  ].join("\r\n");
  const foreignSeed = (workspace: string): void => {
    writeFileSync(join(workspace, "doc.html"), FOREIGN, "utf8");
  };

  it.each([
    {
      method: "POST",
      path: "/api/patch",
      body: { docId: "doc.html", action: "append", targetId: "x", fragment: "<b>x</b>" },
    },
    {
      method: "POST",
      path: "/api/doc/doc.html/annotations",
      body: { selector: { nodeId: "x" }, text: "n" },
    },
  ])(
    "should refuse $path on a foreign doc (derive gate before lock+write)",
    async ({ method, path, body }) => {
      await withServer(async (ctx) => {
        const response = await httpCall(ctx.port, {
          method,
          path,
          headers: { cookie: cookieOf(ctx.token), "x-hr-csrf": "1" },
          body: JSON.stringify(body),
        });
        // derive gate 的具体码按入口分（patch→invalid_document/no_article 422、annotation→needs_normalize 409），
        // 共同不变量：永不 2xx、永不写盘。
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      }, foreignSeed);
    },
  );

  it("should still allow theme writes on a foreign doc (contract: style is allowed)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/style",
        headers: { cookie: cookieOf(ctx.token), "x-hr-csrf": "1" },
        body: JSON.stringify({ docId: "doc.html", visualId: "atelier-editorial" }),
      });
      expect(response.status).toBe(200);
    }, foreignSeed);
  });

  it("should let a trusted foreign doc fetch nothing: local CSP keeps connect-src 'none'", async () => {
    await withServer(async (ctx) => {
      const grant = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/trust",
        headers: { cookie: cookieOf(ctx.token), "x-hr-csrf": "1" },
        body: JSON.stringify({ level: "local" }),
      });
      expect(grant.status).toBe(200);
      const page = await httpCall(ctx.port, {
        path: "/s/doc.html",
        headers: { cookie: cookieOf(ctx.token) },
      });
      const csp = String(page.headers["content-security-policy"]);
      expect(csp).toContain("sandbox allow-scripts");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).not.toContain("allow-same-origin");
    }, foreignSeed);
  });
});
