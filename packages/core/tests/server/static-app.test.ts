// 这层管：M2.2 新增的静态面——`GET /`（构建产物与回退首页）、`GET /assets/*`（穿越攻击）、
// `GET /api/theme/*`（CSS 而不是 JSON）。全部走真 HTTP（`node:net` 原文），断言状态行 + 原始头。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HrError, nodeStyleDeps } from "../../src";
import { nodePatchDeps } from "../../src/io/node-fs";
import { startServer, type RunningServer } from "../../src/server";
import { assetReply, indexReply } from "../../src/server/static";
import { cookieOf, rawExchange } from "./harness";

const DOC = "<article data-hr-id='hr-a'><p>hi</p></article>";

interface AppFixture {
  readonly workspace: string;
  readonly home: string;
  readonly appDir: string;
  readonly server: RunningServer;
  readonly port: number;
  readonly token: string;
}

let fixture: AppFixture | undefined;

const seed = (root: string): void => {
  writeFileSync(join(root, "doc.html"), DOC, "utf8");
};

const isRecordOf = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object";

const statusOf = (raw: string): string => raw.split("\r\n")[0] ?? "";

const bodyOf = (raw: string): string =>
  Buffer.from(raw.slice(raw.indexOf("\r\n\r\n") + 4), "latin1").toString("utf8");

const get = async (path: string, cookie = false): Promise<string> =>
  await rawExchange(
    fixture?.port ?? 0,
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(fixture?.port ?? 0)}${
      cookie && fixture !== undefined ? `\r\nCookie: ${cookieOf(fixture.token)}` : ""
    }\r\nConnection: close\r\n\r\n`,
    undefined,
    4000,
  );

beforeAll(async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hr-app-ws-"));
  const home = mkdtempSync(join(tmpdir(), "hr-app-home-"));
  const appDir = mkdtempSync(join(tmpdir(), "hr-app-dist-"));
  seed(workspace);
  mkdirSync(join(appDir, "assets", "nested"), { recursive: true });
  writeFileSync(join(appDir, "index.html"), "<!doctype html><body>built</body>", "utf8");
  writeFileSync(join(appDir, "assets", "app.js"), "console.info(1);\n", "utf8");
  writeFileSync(join(appDir, "assets", "nested", "x.css"), "a{color:red}\n", "utf8");
  // 穿越靶子：与 assets 同级、只在"`..` 被放过"时可读到的文件（反向变异就靠它变红）。
  writeFileSync(join(appDir, "secret.txt"), "TOP SECRET\n", "utf8");
  const server = await startServer(
    { workspace, port: 0, home, docId: "doc.html", appDir },
    { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
  );
  fixture = { workspace, home, appDir, server, port: server.port, token: server.token };
});

afterAll(async () => {
  await fixture?.server.close();
  for (const dir of [fixture?.workspace, fixture?.home, fixture?.appDir]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const contextOf = (appDir: string, readFile: (path: string) => Promise<Uint8Array>) => ({
  workspace: fixture?.workspace ?? tmpdir(),
  appDir,
  deps: { ...nodePatchDeps, fs: { ...nodePatchDeps.fs, readFile } },
  styleDeps: nodeStyleDeps(fixture?.workspace ?? tmpdir()),
});

describe("static · 未构建与读失败（直接调 Reply 层）", () => {
  it("should fall back to the minimal home page when appDir is empty", async () => {
    const reply = await indexReply(contextOf("", nodePatchDeps.fs.readFile), "doc.html");
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain("当前文档");
    expect(String(reply.body)).toContain("/s/doc.html");
  });

  it("should return 404 when the built index is missing", async () => {
    const reply = await indexReply(contextOf("/nope", nodePatchDeps.fs.readFile), "doc.html");
    expect(reply.status).toBe(404);
    expect(String(reply.body)).toContain("缺少 index.html");
  });

  it("should map a non-missing read failure to io_failure without leaking the path", async () => {
    const failing = () => Promise.reject(new Error("EIO: disk on fire"));
    await expect(indexReply(contextOf("/dist", failing), "doc.html")).rejects.toBeInstanceOf(
      HrError,
    );
    await expect(indexReply(contextOf("/dist", failing), "doc.html")).rejects.toMatchObject({
      code: "io_failure",
      message: "读取静态资源失败",
    });
    await expect(assetReply(contextOf("/dist", failing), "app.js")).rejects.toMatchObject({
      code: "io_failure",
      message: "读取静态资源失败",
    });
  });
});

describe("GET / · 构建产物与回退", () => {
  it("should 302 to /?doc= when the app is built and no doc is pinned (裁定 #1)", async () => {
    const raw = await get("/", true);
    expect(statusOf(raw)).toBe("HTTP/1.1 302 Found");
    const location = raw.split("\r\n").find((line) => line.toLowerCase().startsWith("location:"));
    expect(location).toBe("location: /?doc=doc.html");
    expect(bodyOf(raw)).toBe("");
  });

  it("should serve index.html when ?doc= pins the document", async () => {
    const raw = await get("/?doc=doc.html", true);
    expect(statusOf(raw)).toBe("HTTP/1.1 200 OK");
    expect(raw.toLowerCase()).toContain("content-type: text/html; charset=utf-8");
    expect(raw.toLowerCase()).toContain("content-security-policy: default-src 'none'");
    expect(raw.toLowerCase()).toContain("style-src 'self' 'unsafe-inline'");
    expect(bodyOf(raw)).toContain("built");
  });

  it("should drop the cookie requirement mismatch as a 401", async () => {
    const raw = await get("/");
    expect(statusOf(raw)).toBe("HTTP/1.1 401 Unauthorized");
  });
});

describe("GET /assets/* · 穿越攻击（AC1.2）", () => {
  it("should serve a nested asset with the right type and nosniff", async () => {
    const js = await get("/assets/app.js");
    expect(statusOf(js)).toBe("HTTP/1.1 200 OK");
    expect(js.toLowerCase()).toMatch(/content-type: (application|text)\/javascript/);
    expect(js.toLowerCase()).toContain("x-content-type-options: nosniff");
    expect(js.toLowerCase()).toContain("cache-control: no-store");
    const css = await get("/assets/nested/x.css");
    expect(css.toLowerCase()).toContain("content-type: text/css");
  });

  it.each([
    "/assets/%2e%2e%2fsecret.txt",
    "/assets/..%2fsecret.txt",
    "/assets/..%5csecret.txt",
    "/assets//etc/passwd",
    "/assets/%2fetc/passwd",
    "/assets/%00x",
    "/assets/x%00.txt",
    `/assets/${"a".repeat(2000)}`,
    "/assets/../secret.txt",
    "/assets/a/../secret.txt",
  ])("should answer 404 for %s and never echo a filesystem path", async (path) => {
    const raw = await get(path);
    expect(statusOf(raw)).toBe("HTTP/1.1 404 Not Found");
    expect(bodyOf(raw)).not.toContain("/etc");
    expect(bodyOf(raw)).not.toContain(tmpdir());
    expect(bodyOf(raw)).not.toContain("TOP SECRET");
  });

  it("should answer 404 for a well-formed but missing asset", async () => {
    const raw = await get("/assets/missing.js");
    expect(statusOf(raw)).toBe("HTTP/1.1 404 Not Found");
    expect(bodyOf(raw)).toContain("资源不存在");
  });
});

describe("GET /api/theme · 清单（runtime 的 themes 分支）", () => {
  it("should answer the theme list as JSON with a default name", async () => {
    const raw = await get("/api/theme");
    expect(statusOf(raw)).toBe("HTTP/1.1 200 OK");
    expect(raw.toLowerCase()).toContain("content-type: application/json; charset=utf-8");
    const parsed: unknown = JSON.parse(bodyOf(raw));
    const record: Readonly<Record<string, unknown>> = isRecordOf(parsed) ? parsed : {};
    expect(Array.isArray(record["themes"])).toBe(true);
    expect(String(record["default"])).toContain("atelier-editorial");
  });
});

describe("GET /api/theme/* · CSS 而不是 JSON（AC5.2）", () => {
  it("should serve the built-in theme as text/css", async () => {
    const raw = await get("/api/theme/atelier-editorial");
    expect(statusOf(raw)).toBe("HTTP/1.1 200 OK");
    expect(raw.toLowerCase()).toContain("content-type: text/css; charset=utf-8");
    expect(bodyOf(raw).trimStart().startsWith("{")).toBe(false);
    expect(bodyOf(raw)).toContain("--");
  });

  it("should map an unknown theme id to 404 unknown_style", async () => {
    const raw = await get("/api/theme/nope");
    expect(statusOf(raw)).toBe("HTTP/1.1 404 Not Found");
    expect(bodyOf(raw)).toContain("unknown_style");
  });

  it("should reject traversal in the theme id without reading outside the themes", async () => {
    const raw = await get("/api/theme/%2e%2e%2f%2e%2e%2fetc%2fpasswd");
    expect(statusOf(raw)).not.toBe("HTTP/1.1 200 OK");
    expect(bodyOf(raw)).not.toContain("root:");
  });
});
