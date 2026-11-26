// 这层管：新增权限 HTTP 面——`POST /api/doc/:docId/permissions`、`GET/POST /api/permissions`、
// `permissions.changed` 广播、2×2 CSP 矩阵、畸形请求体、路径键语义、旧 sha 键迁移。
// 组合矩阵（全局模式 × 单文档授权 × 文档类型）见本文件各 describe；
// 对抗脚本能不能碰到本机 API 归 tests/integration 与 e2e（真浏览器）验证。

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, defaultSeed, httpCall, jsonBodyOf, openSse, withServer } from "./harness";
import { withPost } from "./wire";

const FOREIGN =
  '<!doctype html><html><body><div class="app"><script>1</script>外来</div></body></html>';

// 四档生效组合对应的精确 CSP（与 handlers.ts 的 FOREIGN_CSP 表逐字同构）。
const CSP = {
  "off|off":
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
    "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox",
  "on|off":
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; " +
    "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; " +
    "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
  "off|on":
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' http: https:; " +
    "img-src http: https: data: blob:; media-src http: https: data: blob:; " +
    "font-src http: https: data:; connect-src http: https: ws: wss:; " +
    "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox",
  "on|on":
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http: https:; " +
    "style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; " +
    "media-src http: https: data: blob:; font-src http: https: data:; " +
    "connect-src http: https: ws: wss:; frame-src 'none'; form-action 'none'; " +
    "base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
} as const;

const foreignSeed =
  (files: Readonly<Record<string, string>> = { "doc.html": FOREIGN }) =>
  (workspace: string): void => {
    defaultSeed(workspace);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(workspace, name), content, "utf8");
    }
  };

const cspOf = async (port: number, token: string, docId = "doc.html"): Promise<string> => {
  const response = await httpCall(port, {
    path: `/s/${encodeURIComponent(docId)}`,
    headers: { cookie: cookieOf(token) },
  });
  return String(response.headers["content-security-policy"] ?? "");
};

const infoOf = async (
  port: number,
  token: string,
  docId = "doc.html",
): Promise<Record<string, unknown>> =>
  httpCall(port, {
    path: `/api/doc/${encodeURIComponent(docId)}/info`,
    headers: { cookie: cookieOf(token) },
  }).then((response) => jsonBodyOf(response) as Record<string, unknown>);

const postDocPermissions = (
  port: number,
  token: string,
  body: unknown,
  docId = "doc.html",
): Promise<{ status: number; body: unknown }> =>
  httpCall(port, {
    method: "POST",
    path: `/api/doc/${encodeURIComponent(docId)}/permissions`,
    headers: withPost(token),
    body: JSON.stringify(body),
  }).then((response) => ({ status: response.status, body: jsonBodyOf(response) }));

const getModes = (port: number, token: string): Promise<{ status: number; body: unknown }> =>
  httpCall(port, {
    path: "/api/permissions",
    headers: { cookie: cookieOf(token) },
  }).then((response) => ({ status: response.status, body: jsonBodyOf(response) }));

const postModes = (
  port: number,
  token: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> =>
  httpCall(port, {
    method: "POST",
    path: "/api/permissions",
    headers: withPost(token),
    body: JSON.stringify(body),
  }).then((response) => ({ status: response.status, body: jsonBodyOf(response) }));

const settingsFileOf = (home: string): string => join(home, ".hreader", "permissions.json");

describe("doc permissions · 2×2 CSP 矩阵", () => {
  it("should serve the matching CSP for each scripts×network grant combination", async () => {
    await withServer(async (ctx) => {
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["off|off"]);

      await postDocPermissions(ctx.port, ctx.token, { scripts: true });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["on|off"]);

      await postDocPermissions(ctx.port, ctx.token, { network: true });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["on|on"]);

      await postDocPermissions(ctx.port, ctx.token, { scripts: false });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["off|on"]);

      await postDocPermissions(ctx.port, ctx.token, { network: false });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["off|off"]);
    }, foreignSeed());
  });

  it("should merge a partial write into the existing grant", async () => {
    await withServer(async (ctx) => {
      await postDocPermissions(ctx.port, ctx.token, { scripts: true });
      const written = await postDocPermissions(ctx.port, ctx.token, { network: true });

      expect(written.body).toMatchObject({
        permissions: { scripts: true, network: true },
      });
    }, foreignSeed());
  });

  it("should answer the effective view including sources and modes", async () => {
    await withServer(async (ctx) => {
      const written = await postDocPermissions(ctx.port, ctx.token, { network: true });

      expect(written.status).toBe(200);
      expect(written.body).toMatchObject({
        permissions: {
          scripts: false,
          network: true,
          scriptsSource: "doc",
          networkSource: "doc",
          modes: { scripts: "per-doc", network: "per-doc" },
        },
      });
    }, foreignSeed());
  });
});

describe("doc permissions · 拒绝面", () => {
  it.each([
    ["empty object", {}],
    ["wrong type", { scripts: "yes" }],
    ["null", null],
    ["array", [{ scripts: true }]],
    ["primitive", "local"],
  ])("should answer 400 invalid_request for a malformed body (%s)", async (_label, body) => {
    await withServer(async (ctx) => {
      const { status, body: payload } = await postDocPermissions(ctx.port, ctx.token, body);

      expect(status).toBe(400);
      expect(payload).toMatchObject({ code: "invalid_request" });
    }, foreignSeed());
  });

  it("should tolerate unknown extra fields in the body", async () => {
    await withServer(async (ctx) => {
      const { status } = await postDocPermissions(ctx.port, ctx.token, {
        scripts: true,
        future: "field",
      });
      expect(status).toBe(200);
    }, foreignSeed());
  });

  it("should answer 409 needs_normalize for a managed doc", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await postDocPermissions(ctx.port, ctx.token, { scripts: true });

      expect(status).toBe(409);
      expect(body).toMatchObject({ code: "needs_normalize" });
    });
  });

  it("should answer 409 needs_normalize for a normalizable doc", async () => {
    await withServer(
      async (ctx) => {
        const { status, body } = await postDocPermissions(ctx.port, ctx.token, { scripts: true });

        expect(status).toBe(409);
        expect(body).toMatchObject({ code: "needs_normalize" });
      },
      foreignSeed({ "doc.html": "<article><p>没有 id</p></article>" }),
    );
  });

  it("should answer 400 invalid_payload when body.docId disagrees with the path", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await postDocPermissions(ctx.port, ctx.token, {
        scripts: true,
        docId: "other.html",
      });

      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "invalid_payload" });
    }, foreignSeed());
  });

  it("should answer 403 without the csrf header and 401 without the cookie", async () => {
    await withServer(async (ctx) => {
      const noCsrf = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/permissions",
        headers: { cookie: cookieOf(ctx.token), "content-type": "application/json" },
        body: JSON.stringify({ scripts: true }),
      });
      const noCookie = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/permissions",
        headers: { "x-hr-csrf": "1", "content-type": "application/json" },
        body: JSON.stringify({ scripts: true }),
      });

      expect(noCsrf.status).toBe(403);
      expect(noCookie.status).toBe(401);
    }, foreignSeed());
  });

  it("should publish doc.changed after a grant write so the iframe reloads", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const { status } = await postDocPermissions(ctx.port, ctx.token, { scripts: true });
      const frame = await sse.waitForEvent("doc.changed");
      sse.close();

      expect(status).toBe(200);
      expect(frame.data).toContain('"docId":"doc.html"');
    }, foreignSeed());
  });
});

describe("global permissions · 读写与生效", () => {
  it("should read back the per-doc defaults when no settings file exists", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await getModes(ctx.port, ctx.token);

      expect(status).toBe(200);
      expect(body).toEqual({ modes: { scripts: "per-doc", network: "per-doc" } });
    }, foreignSeed());
  });

  it("should persist a partial write and keep the untouched dimension", async () => {
    await withServer(async (ctx) => {
      await postModes(ctx.port, ctx.token, { scripts: "deny" });
      const { body } = await getModes(ctx.port, ctx.token);

      expect(body).toEqual({ modes: { scripts: "deny", network: "per-doc" } });
      // 落盘面也要核：写的是用户级 ~/.hreader/permissions.json，不是工作区。
      expect(JSON.parse(readFileSync(settingsFileOf(ctx.home), "utf8"))).toEqual({
        scripts: "deny",
        network: "per-doc",
      });
    }, foreignSeed());
  });

  it.each([
    ["unknown mode value", { scripts: "admin" }],
    ["wrong type", { network: 1 }],
    ["empty object", {}],
    ["null", null],
    ["array", []],
  ])("should answer 400 invalid_request for a malformed modes body (%s)", async (_l, body) => {
    await withServer(async (ctx) => {
      const { status, body: payload } = await postModes(ctx.port, ctx.token, body);

      expect(status).toBe(400);
      expect(payload).toMatchObject({ code: "invalid_request" });
    }, foreignSeed());
  });

  it("should answer 403 without csrf on write and 401 without cookie on read", async () => {
    await withServer(async (ctx) => {
      const noCsrf = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/permissions",
        headers: { cookie: cookieOf(ctx.token), "content-type": "application/json" },
        body: JSON.stringify({ scripts: "allow" }),
      });
      const noCookie = await httpCall(ctx.port, { path: "/api/permissions" });

      expect(noCsrf.status).toBe(403);
      expect(noCookie.status).toBe(401);
    }, foreignSeed());
  });

  it("should broadcast permissions.changed after a modes write", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      await postModes(ctx.port, ctx.token, { network: "allow" });
      const frame = await sse.waitForEvent("permissions.changed");
      sse.close();

      expect(frame.data).toContain('"network":"allow"');
    }, foreignSeed());
  });

  it("should fall back to defaults when the settings file is corrupt, then heal on write", async () => {
    await withServer(async (ctx) => {
      mkdirSync(join(ctx.home, ".hreader"), { recursive: true });
      writeFileSync(settingsFileOf(ctx.home), "{oops", "utf8");

      expect(await getModes(ctx.port, ctx.token)).toMatchObject({
        body: { modes: { scripts: "per-doc", network: "per-doc" } },
      });

      const { status } = await postModes(ctx.port, ctx.token, { network: "deny" });
      expect(status).toBe(200);
      expect(await getModes(ctx.port, ctx.token)).toMatchObject({
        body: { modes: { scripts: "per-doc", network: "deny" } },
      });
    }, foreignSeed());
  });

  it("should answer a readable 500, not hang, when the settings file is read-only", async () => {
    await withServer(async (ctx) => {
      mkdirSync(join(ctx.home, ".hreader"), { recursive: true });
      writeFileSync(settingsFileOf(ctx.home), JSON.stringify({ scripts: "per-doc" }), "utf8");
      chmodSync(settingsFileOf(ctx.home), 0o444);
      try {
        const { status, body } = await postModes(ctx.port, ctx.token, { scripts: "allow" });

        expect(status).toBe(500);
        expect(body).toMatchObject({ code: "io_failure" });
      } finally {
        chmodSync(settingsFileOf(ctx.home), 0o644);
      }
    }, foreignSeed());
  });
});

describe("global permissions · 模式 × 单文档合成", () => {
  it.each([
    ["allow", CSP["on|off"]],
    ["deny", CSP["off|off"]],
    ["per-doc", CSP["off|off"]],
  ])("should apply scripts mode %s over a denied doc grant", async (mode, expected) => {
    await withServer(async (ctx) => {
      await postModes(ctx.port, ctx.token, { scripts: mode });
      expect(await cspOf(ctx.port, ctx.token)).toBe(expected);
    }, foreignSeed());
  });

  it("should let global allow override a denied doc grant, and global deny override a granted one", async () => {
    await withServer(async (ctx) => {
      await postModes(ctx.port, ctx.token, { scripts: "allow", network: "allow" });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["on|on"]);
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        permissions: { scriptsSource: "global", networkSource: "global" },
      });

      // 单文档记录保留在存储里，但被全局模式忽略。
      await postDocPermissions(ctx.port, ctx.token, { scripts: false, network: false });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["on|on"]);

      await postModes(ctx.port, ctx.token, { scripts: "deny", network: "deny" });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["off|off"]);

      // 切回 per-doc：写过的记录重新生效（scripts:false,network:false → 仍全关）。
      await postModes(ctx.port, ctx.token, { scripts: "per-doc", network: "per-doc" });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["off|off"]);
    }, foreignSeed());
  });

  it("should keep per-doc records dormant under global modes and revive them on per-doc", async () => {
    await withServer(async (ctx) => {
      await postDocPermissions(ctx.port, ctx.token, { scripts: true, network: true });
      await postModes(ctx.port, ctx.token, { scripts: "deny", network: "deny" });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["off|off"]);

      await postModes(ctx.port, ctx.token, { scripts: "per-doc", network: "per-doc" });
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["on|on"]);
    }, foreignSeed());
  });
});

describe("doc permissions · 路径键语义", () => {
  it("should lose the grant after the file is renamed (a new address)", async () => {
    await withServer(async (ctx) => {
      await postDocPermissions(ctx.port, ctx.token, { scripts: true });
      renameSync(ctx.file, join(ctx.workspace, "renamed.html"));

      // 新路径没有记录 → 回落全关；旧路径已无文件。
      expect(await cspOf(ctx.port, ctx.token, "renamed.html")).toBe(CSP["off|off"]);
    }, foreignSeed());
  });

  it("should keep the grant when the file is deleted and recreated at the same path", async () => {
    await withServer(async (ctx) => {
      await postDocPermissions(ctx.port, ctx.token, { scripts: true });
      renameSync(ctx.file, join(ctx.workspace, "moved-away.html"));
      writeFileSync(ctx.file, FOREIGN, "utf8");

      // 同路径重建继承授权——已拍板接受（按路径记授权的固有语义）。
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["on|off"]);
    }, foreignSeed());
  });

  it("should share the grant between a symlink and its target (same real path)", async () => {
    await withServer(async (ctx) => {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(ctx.file, join(ctx.workspace, "alias.html"));
      await postDocPermissions(ctx.port, ctx.token, { scripts: true }, "alias.html");

      // docId 经 realpath 归一：链接与目标是同一条记录。
      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["on|off"]);
      expect(await cspOf(ctx.port, ctx.token, "alias.html")).toBe(CSP["on|off"]);
    }, foreignSeed());
  });

  it("should grant a foreign doc under a subdirectory and unicode names", async () => {
    await withServer(async (ctx) => {
      mkdirSync(join(ctx.workspace, "sub 目录"));
      writeFileSync(join(ctx.workspace, "sub 目录", "外 来 😀.html"), FOREIGN, "utf8");
      const docId = "sub 目录/外 来 😀.html";

      const { status } = await postDocPermissions(ctx.port, ctx.token, { scripts: true }, docId);
      expect(status).toBe(200);
      expect(await cspOf(ctx.port, ctx.token, docId)).toBe(CSP["on|off"]);
    }, foreignSeed());
  });

  it("should fold case variants onto the real path on a case-insensitive volume", async () => {
    await withServer(async (ctx) => {
      const upper = await httpCall(ctx.port, {
        path: "/s/DOC.HTML",
        headers: { cookie: cookieOf(ctx.token) },
      });
      await postDocPermissions(ctx.port, ctx.token, { scripts: true });

      if (upper.status === 200) {
        // 大小写不敏感卷（macOS 默认 APFS）：DOC.HTML 与 doc.html 同一条记录。
        expect(await cspOf(ctx.port, ctx.token, "DOC.HTML")).toBe(CSP["on|off"]);
      } else {
        // 大小写敏感卷：DOC.HTML 是另一条路径（且不存在），授权天然不适用。
        expect(upper.status).toBe(404);
      }
    }, foreignSeed());
  });

  it("should refuse a docId that escapes the workspace via %2e%2e", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/%2e%2e%2fescape.html/permissions",
        headers: withPost(ctx.token),
        body: JSON.stringify({ scripts: true }),
      });

      expect(response.status).toBe(403);
    }, foreignSeed());
  });
});

describe("doc permissions · 旧 sha 键迁移（HTTP 级）", () => {
  it("should migrate a matching legacy sha record on first read and keep serving local", async () => {
    await withServer(async (ctx) => {
      // 手写一份"旧版本"的 trust.json：键是内容 sha256，值是字符串档。
      const sha = createHash("sha256").update(readFileSync(ctx.file)).digest("hex");
      mkdirSync(join(ctx.workspace, ".hreader"), { recursive: true });
      writeFileSync(
        join(ctx.workspace, ".hreader", "trust.json"),
        JSON.stringify({ [sha]: "local" }),
        "utf8",
      );

      expect(await cspOf(ctx.port, ctx.token)).toBe(CSP["on|off"]);

      // 迁移落盘：路径键 + 旧 sha 键并存（幂等，对不上的旧键不动）。
      const table: unknown = JSON.parse(
        readFileSync(join(ctx.workspace, ".hreader", "trust.json"), "utf8"),
      );
      expect(table).toMatchObject({
        "doc.html": { scripts: true, network: false },
        [sha]: "local",
      });
    }, foreignSeed());
  });
});
