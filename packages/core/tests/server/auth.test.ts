// 这层管：鉴权矩阵——cookie / ?t= / Host / Origin / CSRF；全部走真 socket。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cookieOf, httpCall, rawExchange, withServer } from "./harness";
import { rawRequest, withCookie, withPost } from "./wire";

const FORGED_HOSTS = ["127.0.0.1:1", "evil.example", "127.0.0.1", "127.0.0.1:8443"];

const deleteBody = (): string =>
  JSON.stringify({ docId: "doc.html", action: "delete", targetId: "hr-b" });

describe("auth · cookie", () => {
  it("should reject a request without the session cookie (401)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/api/doc/doc.html/model" });

      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ code: "unauthorized" });
    });
  });

  it("should reject a wrong cookie (401) and accept the right one", async () => {
    await withServer(async (ctx) => {
      const wrong = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: "hr=not-the-token" },
      });
      const right = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(wrong.status).toBe(401);
      expect(right.status).toBe(200);
    });
  });
});

describe("auth · ?t= 入口", () => {
  it("should 302 to the same path without t and set an HttpOnly cookie", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: `/s/doc.html?t=${encodeURIComponent(ctx.token)}`,
      });

      expect(response.status).toBe(302);
      expect(response.headers["location"]).toBe("/s/doc.html");
      expect(String(response.headers["set-cookie"])).toContain("HttpOnly");
      expect(String(response.headers["set-cookie"])).toContain("SameSite=Strict");
      expect(response.headers["location"]).not.toContain("t=");
    });
  });

  it("should reject a forged t (401)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/s/doc.html?t=forged" });

      expect(response.status).toBe(401);
    });
  });

  // D5 要求 cookie 是"随机 32B 会话 secret"；现状把 daemon token 直接当 cookie 发。
  // 后果：token 泄漏面从"一次性入口"扩大到每个请求，且无法单独吊销会话。
  it.fails(
    "should mint a fresh session secret instead of reusing the daemon token (D5)",
    async () => {
      await withServer(async (ctx) => {
        const response = await httpCall(ctx.port, {
          path: `/s/doc.html?t=${encodeURIComponent(ctx.token)}`,
        });

        expect(String(response.headers["set-cookie"])).not.toContain(ctx.token);
      });
    },
  );
});

describe("auth · Host 与 Origin", () => {
  it.each(FORGED_HOSTS)("should reject Host %s with 403 forbidden_origin", async (host) => {
    await withServer(async (ctx) => {
      const raw = await rawExchange(
        ctx.port,
        rawRequest(ctx.port, {
          method: "GET",
          path: "/healthz",
          host,
          headers: withCookie(ctx.token),
        }),
        "HTTP/1.1",
      );

      expect(raw).toContain("403");
      expect(raw).toContain('"code":"forbidden_origin"');
    });
  });

  it("should reject Origin with a .evil.com suffix and allow the real one", async () => {
    await withServer(async (ctx) => {
      const evil = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token, { Origin: `http://127.0.0.1:${String(ctx.port)}.evil.com` }),
        body: deleteBody(),
      });
      const ok = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token, { Origin: `http://127.0.0.1:${String(ctx.port)}` }),
        body: deleteBody(),
      });

      expect(evil.status).toBe(403);
      expect(JSON.parse(evil.body)).toEqual({ code: "forbidden_origin" });
      expect(ok.status).toBe(200);
    });
  });
});

describe("auth · CSRF", () => {
  it("should reject a POST without X-HR-CSRF (403) and keep the bytes", async () => {
    await withServer(async (ctx) => {
      const before = readFileSync(ctx.file);
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withCookie(ctx.token),
        body: deleteBody(),
      });

      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ code: "forbidden_origin" });
      expect(readFileSync(ctx.file).equals(before)).toBe(true);
    });
  });

  it("should reject a wrong CSRF value (403)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token, { "X-HR-CSRF": "0" }),
        body: deleteBody(),
      });

      expect(response.status).toBe(403);
    });
  });
});
