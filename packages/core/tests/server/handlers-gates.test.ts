// 这层管：handlers 残余变异体的行为锚点——响应头契约、info 的 kind/trust 门、
// 外来文档的归一化报错文案、managed 归一化的零副作用、托管文档换主题的回执形状。

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, defaultSeed, DOC, httpCall, jsonBodyOf, withServer } from "./harness";
import { withPost } from "./wire";

const FOREIGN = '<!doctype html><html><body><div class="app">plain</div></body></html>';
const FOREIGN_MULTI =
  '<article data-hr-kind="report"><p>a</p></article><article data-hr-kind="slides"><p>b</p></article>';

const seedWith =
  (html: string) =>
  (workspace: string): void => {
    defaultSeed(workspace);
    writeFileSync(join(workspace, "doc.html"), html, "utf8");
  };

const post = (port: number, token: string, path: string, body: unknown = {}) =>
  httpCall(port, {
    method: "POST",
    path,
    headers: withPost(token),
    body: JSON.stringify(body),
  });

const infoOf = (port: number, token: string) =>
  httpCall(port, {
    path: "/api/doc/doc.html/info",
    headers: { cookie: cookieOf(token) },
  }).then((response) => jsonBodyOf(response) as Record<string, unknown>);

describe("handlers · 响应头契约", () => {
  it("should answer JSON api routes with the json content-type and nosniff", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/info",
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(response.status).toBe(200);
      expect(String(response.headers["content-type"])).toContain("application/json");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  it("should answer the foreign document route with sandbox CSP and nosniff", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/s/doc.html",
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(response.status).toBe(200);
      const csp = String(response.headers["content-security-policy"] ?? "");
      expect(csp).toContain("sandbox");
      expect(csp).not.toContain("allow-same-origin");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }, seedWith(FOREIGN));
  });
});

describe("doc info · kind 与陈旧 trust 的边界", () => {
  it("should omit kind when the doc carries multiple articles", async () => {
    await withServer(async (ctx) => {
      const info = await infoOf(ctx.port, ctx.token);
      expect(info["cls"]).toBe("foreign");
      expect(info).not.toHaveProperty("kind");
    }, seedWith(FOREIGN_MULTI));
  });

  it("should report trust off on a doc that turned managed after a grant", async () => {
    await withServer(async (ctx) => {
      const grant = await post(ctx.port, ctx.token, "/api/doc/doc.html/trust", {
        level: "local",
      });
      expect(grant.status).toBe(200);
      // 授权记录还在磁盘上，但文档已经不是外来档：info 必须读 cls 而非读旧记录。
      writeFileSync(ctx.file, DOC, "utf8");
      const info = await infoOf(ctx.port, ctx.token);
      expect(info["cls"]).toBe("managed");
      expect(info["trust"]).toBe("off");
    }, seedWith(FOREIGN));
  });
});

describe("doc normalize · 外来报错文案与 managed 零副作用", () => {
  it("should answer invalid_document naming the missing article", async () => {
    await withServer(async (ctx) => {
      const response = await post(ctx.port, ctx.token, "/api/doc/doc.html/normalize");
      const body = jsonBodyOf(response) as { code: string; message: string };
      expect(response.status).toBe(422);
      expect(body.code).toBe("invalid_document");
      expect(body.message).toContain("没有 <article>");
    }, seedWith(FOREIGN));
  });

  it("should answer invalid_document counting the articles", async () => {
    await withServer(async (ctx) => {
      const response = await post(ctx.port, ctx.token, "/api/doc/doc.html/normalize");
      const body = jsonBodyOf(response) as { code: string; message: string };
      expect(response.status).toBe(422);
      expect(body.code).toBe("invalid_document");
      expect(body.message).toContain("2 个 <article>");
    }, seedWith(FOREIGN_MULTI));
  });

  it("should leave no history snapshot when normalizing a managed doc", async () => {
    await withServer(async (ctx) => {
      const response = await post(ctx.port, ctx.token, "/api/doc/doc.html/normalize");
      expect(response.status).toBe(200);
      expect(jsonBodyOf(response)).toMatchObject({ cls: "managed" });
      // `cls === "managed"` 提前返回被拆掉的话会走 normalizeFile：文件没变但留下快照——抓的就是这个副作用。
      const historyDir = join(ctx.workspace, ".hreader", "history");
      const snapshots = existsSync(historyDir)
        ? readdirSync(historyDir, { recursive: true }).length
        : 0;
      expect(snapshots).toBe(0);
    });
  });
});

describe("handlers · 换主题与信任档回执", () => {
  it("should reply the frozen shape when styling a managed doc", async () => {
    await withServer(async (ctx) => {
      const response = await post(ctx.port, ctx.token, "/api/style", {
        docId: "doc.html",
        visualId: "atelier-editorial",
      });
      expect(response.status).toBe(200);
      const body = jsonBodyOf(response) as Record<string, unknown>;
      expect(body["changed"]).toBe(true);
      expect(body["changedNodes"]).toBeInstanceOf(Array);
      expect(response.body).not.toContain("Stryker");
    });
  });

  it("should answer needs_normalize with the trust message on a managed doc", async () => {
    await withServer(async (ctx) => {
      const response = await post(ctx.port, ctx.token, "/api/doc/doc.html/trust", {
        level: "local",
      });
      const body = jsonBodyOf(response) as { code: string; message: string };
      expect(response.status).toBe(409);
      expect(body.code).toBe("needs_normalize");
      expect(body.message).toContain("信任档只对外来文档开放");
    });
  });

  it("should expose status pending on a freshly appended annotation", async () => {
    await withServer(async (ctx) => {
      const created = await post(ctx.port, ctx.token, "/api/annotation", {
        docId: "doc.html",
        start: 0,
        end: 2,
        text: "正文",
        note: "note",
      });
      expect(created.status).toBe(201);
      const list = jsonBodyOf(
        await httpCall(ctx.port, {
          path: "/api/doc/doc.html/annotations",
          headers: { Cookie: cookieOf(ctx.token) },
        }),
      ) as { annotations: { status: string }[] };
      expect(list.annotations).toHaveLength(1);
      expect(list.annotations[0]?.status).toBe("pending");
      expect(readFileSync(ctx.file, "utf8")).toContain("pending");
    });
  });
});
