// 这层管：CSP/沙箱的系统扫查——逐档核对 `sandbox` 指令、
// `allow-scripts` 与 `allow-same-origin` 永不同现、`frame-src 'self'` 在 APP_CSP 里。
// `/s/` 302 到的 `/f/<cap>/<doc>` 被顶层直接打开时下发的头与 iframe 内是同一份：隔离由 `sandbox` 指令兜住。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { startServer } from "../../src/server/server";
import { nodeStyleDeps } from "../../src/style";
import { cookieOf, defaultSeed, docPageOf, httpCall, withServer } from "./harness";
import { withPost } from "./wire";

const FOREIGN = [
  "<!doctype html>",
  '<html><body><div class="app"><script>alert(1)</script>外来</div></body></html>',
].join("\r\n");

const OFF_CSP =
  "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; media-src 'self'; " +
  "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox";
const LOCAL_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self'; " +
  "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; " +
  "sandbox allow-scripts";
const MANAGED_CSP = "default-src 'none'; style-src 'unsafe-inline'";

const foreignSeed = (workspace: string): void => {
  defaultSeed(workspace);
  writeFileSync(join(workspace, "foreign.html"), FOREIGN, "utf8");
};

const cspOf = async (
  port: number,
  token: string,
  path: string,
): Promise<{ status: number; csp: string }> => {
  // `/s/` and `/` keep the cookie entry; `/f/` doc requests arrive without one.
  const response = path.startsWith("/s/")
    ? await docPageOf(port, token, path.slice(3))
    : await httpCall(port, { path, headers: { cookie: cookieOf(token) } });
  return {
    status: response.status,
    csp: String(response.headers["content-security-policy"] ?? ""),
  };
};

const grant = (port: number, token: string, docId: string, level: string): Promise<number> =>
  httpCall(port, {
    method: "POST",
    path: `/api/doc/${docId}/trust`,
    headers: withPost(token),
    body: JSON.stringify({ level }),
  }).then((response) => response.status);

/** 通用不变量：任何文档页 CSP 的 sandbox 段都不许带回同源身份。 */
const assertSandboxIsolated = (csp: string): void => {
  const sandbox = /sandbox ([^;]*)/u.exec(csp)?.[1] ?? "";
  expect(sandbox).not.toContain("allow-same-origin");
  if (sandbox.includes("allow-scripts")) {
    expect(sandbox).not.toContain("allow-same-origin");
  }
};

describe("CSP · 外来文档按信任档", () => {
  it("should serve the off CSP (bare sandbox, no allow-scripts) before any grant", async () => {
    await withServer(async (ctx) => {
      const { status, csp } = await cspOf(ctx.port, ctx.token, "/s/foreign.html");

      expect(status).toBe(200);
      expect(csp).toBe(OFF_CSP);
      expect(csp).not.toContain("allow-scripts");
      assertSandboxIsolated(csp);
    }, foreignSeed);
  });

  it("should serve the local CSP after a local grant, still without same-origin", async () => {
    await withServer(async (ctx) => {
      expect(await grant(ctx.port, ctx.token, "foreign.html", "local")).toBe(200);
      const { csp } = await cspOf(ctx.port, ctx.token, "/s/foreign.html");

      expect(csp).toBe(LOCAL_CSP);
      expect(csp).toContain("sandbox allow-scripts");
      assertSandboxIsolated(csp);
    }, foreignSeed);
  });

  it("should serve the managed CSP for a managed doc regardless of trust calls", async () => {
    await withServer(async (ctx) => {
      const { csp } = await cspOf(ctx.port, ctx.token, "/s/doc.html");

      expect(csp).toBe(MANAGED_CSP);
      expect(csp).not.toContain("sandbox");
    }, foreignSeed);
  });
});

describe("CSP · 顶层直接打开 /f/", () => {
  it("should keep the sandbox CSP when the doc page is the top-level navigation", async () => {
    await withServer(async (ctx) => {
      // 顶层打开没有 iframe sandbox 属性可依赖：沙箱只剩响应头这一条防线，必须原地生效。
      const { status, csp } = await cspOf(ctx.port, ctx.token, "/s/foreign.html");

      expect(status).toBe(200);
      expect(csp).toContain("sandbox");
      expect(csp).not.toContain("allow-same-origin");
      expect(csp).toContain("default-src 'none'");
      // 脚本关档不下发 connect-src 'self'：页面跑不了 fetch，给出这个源只是徒增表面。
      expect(csp).not.toContain("connect-src 'self'");
    }, foreignSeed);
  });
});

describe("CSP · 首页与构建产物", () => {
  it("should serve the tightened fallback CSP on the unbuilt home", async () => {
    await withServer(async (ctx) => {
      const { status, csp } = await cspOf(ctx.port, ctx.token, "/");

      expect(status).toBe(200);
      expect(csp).toBe("default-src 'none'; style-src 'unsafe-inline'");
      expect(csp).not.toContain("script-src");
      expect(csp).not.toContain("allow-same-origin");
    });
  });

  it("should carry frame-src 'self' (and no sandbox) on the built app shell", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hr-csp-ws-")));
    const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-csp-home-")));
    const appDir = realpathSync(mkdtempSync(join(tmpdir(), "hr-csp-app-")));
    defaultSeed(workspace);
    mkdirSync(join(appDir, "assets"), { recursive: true });
    writeFileSync(join(appDir, "index.html"), "<!doctype html><p>app</p>", "utf8");
    const server = await startServer(
      { workspace, port: 0, home, docId: "doc.html", appDir },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
    );
    try {
      const { status, csp } = await cspOf(server.port, server.token, "/?doc=doc.html");

      expect(status).toBe(200);
      expect(csp).toContain("frame-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("sandbox");
      expect(csp).not.toContain("allow-same-origin");
    } finally {
      await server.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(appDir, { recursive: true, force: true });
    }
  });
});
