// 这层管：协议边界缺陷——HTTP 方法大小写、`--allow-host` 与 Origin 不一致、
// 非 UTF-8 请求体的状态码、未构建时 `/assets/*` 落到 CWD 的越权读。

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { originAllowed } from "../../src/server/auth";
import { createCapabilityBook } from "../../src/server/capability";
import { matchRoute } from "../../src/server/routes";
import { startServer } from "../../src/server/server";
import { assetReply } from "../../src/server/static";
import { nodeStyleDeps } from "../../src/style";
import { depsOf, fakeFs, fixedClock, recordingSleep } from "../io/harness";
import { cookieOf, defaultSeed, rawExchange, withServer } from "./harness";
import { rawRequest } from "./wire";

describe("method · 大小写", () => {
  // RFC 9110 §9.1：method token 区分大小写；`get` 不是 `GET`。
  it("should not treat a lowercase method as GET in matchRoute", () => {
    const lookup = matchRoute("get", "/healthz");

    expect(lookup.kind).toBe("method");
  });

  it("should not serve a lowercase get on the wire", async () => {
    await withServer(async (ctx) => {
      const raw = await rawExchange(
        ctx.port,
        `get /healthz HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\n\r\n`,
        "HTTP/1.1",
      );

      // llhttp 在解析层就拒了小写方法（400 Parse Error，不进路由）；
      // 若哪天进了路由，matchRoute 的精确匹配再兜成 405——反正不许 200。
      expect(raw).not.toContain(" 200 ");
      expect(raw).toMatch(/HTTP\/1\.1 (400|405)/u);
    });
  });
});

describe("origin · allow-host", () => {
  it("should extend the Origin allowlist with the configured allowHosts", () => {
    expect(originAllowed("http://test.local:4321", 4321, ["test.local:4321"])).toBe(true);
    expect(originAllowed("http://evil.example:4321", 4321, ["test.local:4321"])).toBe(false);
    expect(originAllowed("http://127.0.0.1:4321", 4321)).toBe(true);
  });
});

const freePortOf = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return port;
};

describe("origin · allow-host（走线）", () => {
  it("should serve requests whose Origin matches a custom allowHost", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hr-host-ws-")));
    const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-host-home-")));
    defaultSeed(workspace);
    let server;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = await freePortOf();
      try {
        server = await startServer(
          {
            workspace,
            port,
            home,
            docId: "doc.html",
            allowHosts: [`test.local:${String(port)}`],
          },
          { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
        );
        break;
      } catch (error: unknown) {
        const code: unknown = Reflect.get(Object(error), "code");
        if (code !== "port_in_use" || attempt === 2) throw error;
      }
    }
    if (server === undefined) throw new Error("startServer 未返回实例");
    const port = server.port;
    try {
      const allowed = await rawExchange(
        port,
        rawRequest(port, {
          method: "GET",
          path: "/healthz",
          host: `test.local:${String(port)}`,
          headers: { Origin: `http://test.local:${String(port)}` },
        }),
        "HTTP/1.1",
      );
      const evil = await rawExchange(
        port,
        rawRequest(port, {
          method: "GET",
          path: "/healthz",
          host: `test.local:${String(port)}`,
          headers: { Origin: "http://evil.example" },
        }),
        "HTTP/1.1",
      );

      expect(allowed).toContain("200");
      expect(evil).toContain("403");
      expect(evil).toContain('"forbidden_origin"');
    } finally {
      await server.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("body · 非法 UTF-8", () => {
  it("should answer 400 invalid_request for a non-UTF8 request body", async () => {
    await withServer(async (ctx) => {
      const raw = await rawExchange(
        ctx.port,
        `POST /api/patch HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nX-HR-CSRF: 1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n\xFF\xFE`,
        "HTTP/1.1",
      );

      expect(raw).toContain("400");
      expect(raw).toContain('"invalid_request"');
      expect(raw).not.toContain("500");
    });
  });
});

describe("assets · 未构建", () => {
  it("should 404 without touching the fs when appDir is empty", async () => {
    const fake = fakeFs({ "assets/leak.js": "pwned()" });
    const { clock } = fixedClock(1_000);
    const { sleep } = recordingSleep();
    const styleDeps = nodeStyleDeps("/nonexistent");
    const reply = await assetReply(
      {
        workspace: "/nonexistent",
        appDir: "",
        home: "/nonexistent",
        deps: depsOf(fake.port, clock, sleep),
        styleDeps,
        caps: createCapabilityBook(),
      },
      "leak.js",
    );

    expect(reply.status).toBe(404);
    expect(fake.state.log.some((line) => line.startsWith("readFile"))).toBe(false);
  });
});
