// 这层管：`POST /api/doc/:docId/trust`——只有外来文档能设档、`/s/` 按档下发 CSP、
// info 回 `trust`/`scripts`、写后推 doc.changed；以及"内容一变信任即失效"。

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, defaultSeed, httpCall, jsonBodyOf, openSse, withServer } from "./harness";
import { withPost } from "./wire";

const FOREIGN_WITH_SCRIPT =
  '<!doctype html><html><body><div class="app"><script>window.x=1</script></div></body></html>';

const FOREIGN_CLEAN = '<!doctype html><html><body><div class="app">plain</div></body></html>';

const OFF_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
const LOCAL_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; " +
  "frame-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

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
  const response = await httpCall(port, {
    path: `/s/${docId}`,
    headers: { cookie: cookieOf(token) },
  });
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

  it("should fall back to off when the document bytes change after a grant", async () => {
    await withServer(async (ctx) => {
      await postTrust(ctx.port, ctx.token, "local");
      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({ trust: "local" });

      writeFileSync(ctx.file, `${FOREIGN_WITH_SCRIPT}<!-- v2 -->`, "utf8");

      expect(await infoOf(ctx.port, ctx.token)).toMatchObject({ trust: "off" });
      expect(await cspOf(ctx.port, ctx.token)).toBe(OFF_CSP);
    }, foreignSeed());
  });
});
