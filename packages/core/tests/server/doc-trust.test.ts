// 这层管：`POST /api/doc/:docId/trust` 的兼容面——只有外来文档能设档、`/s/` 按生效
// 脚本位下发 CSP、info 回 `trust`/`scripts`/`permissions`、写后推 doc.changed；
// 以及路径键语义：内容改动（含 style 写入）不再收回授权。

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cookieOf,
  defaultSeed,
  docPageOf,
  httpCall,
  jsonBodyOf,
  openSse,
  withServer,
} from "./harness";
import { withPost } from "./wire";

const FOREIGN_WITH_SCRIPT =
  '<!doctype html><html><body><div class="app"><script>window.x=1</script></div></body></html>';

const FOREIGN_CLEAN = '<!doctype html><html><body><div class="app">plain</div></body></html>';

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

const foreignSeed =
  (html = FOREIGN_WITH_SCRIPT) =>
  (workspace: string): void => {
    defaultSeed(workspace);
    writeFileSync(join(workspace, "doc.html"), html, "utf8");
  };

const postTrust = (
  port: number,
  token: string,
  level: unknown,
  docId = "doc.html",
): Promise<{ status: number; body: unknown }> =>
  httpCall(port, {
    method: "POST",
    path: `/api/doc/${docId}/trust`,
    headers: withPost(token),
    body: JSON.stringify({ level }),
  }).then((response) => ({ status: response.status, body: jsonBodyOf(response) }));

const cspOf = async (port: number, token: string, docId = "doc.html"): Promise<string> => {
  const response = await docPageOf(port, token, docId);
  return String(response.headers["content-security-policy"] ?? "");
};

const infoOf = async (port: number, token: string): Promise<Record<string, unknown>> =>
  httpCall(port, {
    path: "/api/doc/doc.html/info",
    headers: { cookie: cookieOf(token) },
  }).then((response) => jsonBodyOf(response) as Record<string, unknown>);

describe("doc trust · 下发 CSP", () => {
  it("should serve the off CSP for a foreign doc before any grant", async () => {
    await withServer(async (ctx) => {
      const csp = await cspOf(ctx.port, ctx.token);

      expect(csp).toBe(OFF_CSP);
      expect(csp).not.toContain("allow-same-origin");
    }, foreignSeed());
  });

  it("should serve the local CSP after granting local, and fall back to off after revoking", async () => {
    await withServer(async (ctx) => {
      const granted = await postTrust(ctx.port, ctx.token, "local");
      expect(granted.status).toBe(200);
      expect(granted.body).toMatchObject({ trust: "local" });

      const localCsp = await cspOf(ctx.port, ctx.token);
      expect(localCsp).toBe(LOCAL_CSP);
      expect(localCsp).toContain("sandbox allow-scripts");
      expect(localCsp).not.toContain("allow-same-origin");

      await postTrust(ctx.port, ctx.token, "off");
      expect(await cspOf(ctx.port, ctx.token)).toBe(OFF_CSP);
    }, foreignSeed());
  });

  it("should keep the managed CSP byte-identical to the pre-trust contract", async () => {
    await withServer(async (ctx) => {
      const csp = await cspOf(ctx.port, ctx.token);

      expect(csp).toBe("default-src 'none'; style-src 'unsafe-inline'");
      expect(csp).not.toContain("sandbox");
    });
  });
});

describe("doc trust · info 字段", () => {
  it("should report trust/scripts on a foreign doc and flip trust after a grant", async () => {
    await withServer(async (ctx) => {
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        cls: "foreign",
        trust: "off",
        scripts: true,
      });

      await postTrust(ctx.port, ctx.token, "local");

      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        cls: "foreign",
        trust: "local",
        scripts: true,
      });
    }, foreignSeed());
  });

  it("should expose the effective two-dimension permissions on a foreign doc", async () => {
    await withServer(async (ctx) => {
      // 默认（双 per-doc、无授权）：两维都关、出处都是单文档记录。
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        permissions: {
          scripts: false,
          network: false,
          scriptsSource: "doc",
          networkSource: "doc",
          modes: { scripts: "per-doc", network: "per-doc" },
        },
      });

      // trust=local 映成 grant {scripts:true, network:false}：network 维保持关。
      await postTrust(ctx.port, ctx.token, "local");
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        permissions: { scripts: true, network: false },
      });
    }, foreignSeed());
  });

  it("should omit the permissions field for managed and normalizable docs", async () => {
    await withServer(async (ctx) => {
      const info = await infoOf(ctx.port, ctx.token);
      expect(info).toMatchObject({ cls: "managed", trust: "off" });
      expect("permissions" in info).toBe(false);
    });
    await withServer(async (ctx) => {
      const info = await infoOf(ctx.port, ctx.token);
      expect(info).toMatchObject({ cls: "normalizable" });
      expect("permissions" in info).toBe(false);
    }, foreignSeed("<article><p>没有 id</p></article>"));
  });

  it("should report scripts false for a foreign doc without executable content", async () => {
    await withServer(async (ctx) => {
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        cls: "foreign",
        scripts: false,
      });
    }, foreignSeed(FOREIGN_CLEAN));
  });

  it("should report trust off and honest scripts for a managed doc", async () => {
    await withServer(async (ctx) => {
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        cls: "managed",
        trust: "off",
        scripts: false,
      });
    });
  });
});

describe("doc trust · 拒绝面", () => {
  it("should answer 409 needs_normalize for a managed doc", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await postTrust(ctx.port, ctx.token, "local");

      expect(status).toBe(409);
      expect(body).toMatchObject({ code: "needs_normalize" });
    });
  });

  it("should answer 409 needs_normalize for a normalizable doc", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await postTrust(ctx.port, ctx.token, "local");

      expect(status).toBe(409);
      expect(body).toMatchObject({ code: "needs_normalize" });
    }, foreignSeed("<article><p>没有 id</p></article>"));
  });

  it("should answer 400 invalid_request for an unknown level", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await postTrust(ctx.port, ctx.token, "admin");

      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "invalid_request" });
    }, foreignSeed());
  });

  it("should answer 403 without the csrf header and 401 without the cookie", async () => {
    await withServer(async (ctx) => {
      const noCsrf = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/trust",
        headers: { cookie: cookieOf(ctx.token), "content-type": "application/json" },
        body: JSON.stringify({ level: "local" }),
      });
      const noCookie = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/trust",
        headers: { "x-hr-csrf": "1", "content-type": "application/json" },
        body: JSON.stringify({ level: "local" }),
      });

      expect(noCsrf.status).toBe(403);
      expect(jsonBodyOf(noCsrf)).toMatchObject({ code: "forbidden_origin" });
      expect(noCookie.status).toBe(401);
    }, foreignSeed());
  });
});

describe("doc trust · legacy route keeps the network dimension", () => {
  const postPermissions = (
    port: number,
    token: string,
    patch: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> =>
    httpCall(port, {
      method: "POST",
      path: "/api/doc/doc.html/permissions",
      headers: withPost(token),
      body: JSON.stringify(patch),
    }).then((response) => ({ status: response.status, body: jsonBodyOf(response) }));

  it("should keep the network grant when the trust route toggles only scripts", async () => {
    await withServer(async (ctx) => {
      // 新接口先开联网：单文档 grant {scripts:false, network:true}。
      const granted = await postPermissions(ctx.port, ctx.token, { network: true });
      expect(granted.status).toBe(200);
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        permissions: { scripts: false, network: true },
      });

      // 旧接口只碰脚本这一维：off = 脚本关，联网必须留在开档。
      const off = await postTrust(ctx.port, ctx.token, "off");
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ trust: "off" });
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        permissions: { scripts: false, network: true },
      });

      // local = 脚本开，联网同样不许被收回。
      const local = await postTrust(ctx.port, ctx.token, "local");
      expect(local.status).toBe(200);
      expect(local.body).toMatchObject({ trust: "local" });
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({
        permissions: { scripts: true, network: true },
      });
    }, foreignSeed());
  });
});

describe("doc trust · SSE 与失效", () => {
  it("should publish doc.changed after a successful grant", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const { status } = await postTrust(ctx.port, ctx.token, "local");
      const frame = await sse.waitForEvent("doc.changed");
      sse.close();

      expect(status).toBe(200);
      expect(frame.data).toContain('"docId":"doc.html"');
    }, foreignSeed());
  });

  it("should keep the grant when the document bytes change after a grant", async () => {
    await withServer(async (ctx) => {
      await postTrust(ctx.port, ctx.token, "local");
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({ trust: "local" });

      // 授权按路径记：字节变了授权保留（用户/agent 编辑文档不再掉档）。
      writeFileSync(ctx.file, `${FOREIGN_WITH_SCRIPT}<!-- v2 -->`, "utf8");

      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({ trust: "local" });
      expect(await cspOf(ctx.port, ctx.token)).toBe(LOCAL_CSP);
    }, foreignSeed());
  });

  it("should keep the grant when a style write changes the document bytes", async () => {
    await withServer(async (ctx) => {
      await postTrust(ctx.port, ctx.token, "local");

      const style = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/style",
        headers: withPost(ctx.token),
        body: JSON.stringify({ docId: "doc.html", visualId: "atelier-editorial" }),
      });

      // 主题写进文件只换字节、不换路径：授权保留——这正是从 sha 键切到路径键要修的问题。
      expect(style.status).toBe(200);
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({ trust: "local" });
      expect(await cspOf(ctx.port, ctx.token)).toBe(LOCAL_CSP);
    }, foreignSeed());
  });
});
