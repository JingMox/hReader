// 这层管：docId 编码面的对抗——合法形态要通（子目录、Unicode、字面 `+`/`%`/点文件），
// `.hreader` 存储区与写路由上的穿越要拒。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DOC, cookieOf, defaultSeed, httpCall, jsonBodyOf, withServer } from "./harness";
import { withPost } from "./wire";

const richSeed = (workspace: string): void => {
  defaultSeed(workspace);
  mkdirSync(join(workspace, "sub"));
  writeFileSync(join(workspace, "sub", "inner.html"), DOC, "utf8");
  writeFileSync(join(workspace, "café.html"), DOC, "utf8");
  writeFileSync(join(workspace, "a+b.html"), DOC, "utf8");
  writeFileSync(join(workspace, "a%b.html"), DOC, "utf8");
  writeFileSync(join(workspace, ".dot.html"), DOC, "utf8");
};

/** `.hreader` 里放个长得像文档的陷阱：存在 ≠ 可读，命中它必须 403 而不是把字节服务出去。 */
const storeSeed = (workspace: string): void => {
  defaultSeed(workspace);
  mkdirSync(join(workspace, ".hreader", "locks"), { recursive: true });
  writeFileSync(join(workspace, ".hreader", "trap.html"), DOC, "utf8");
  writeFileSync(join(workspace, ".hreader", "locks", "held.lock"), "{}", "utf8");
};

const modelOf = async (
  port: number,
  token: string,
  pathDocId: string,
): Promise<{ status: number; code: string }> => {
  const response = await httpCall(port, {
    path: `/api/doc/${pathDocId}/model`,
    headers: { cookie: cookieOf(token) },
  });
  const parsed: unknown = response.body === "" ? {} : JSON.parse(response.body);
  const code =
    typeof parsed === "object" && parsed !== null && "code" in parsed ? String(parsed.code) : "";
  return { status: response.status, code };
};

const appendBody = (docId: string): string =>
  JSON.stringify({ docId, action: "append", targetId: "hr-d", fragment: "<b>t</b>" });

describe("docId · 合法形态照过", () => {
  it("should serve a subdirectory doc through %2F", async () => {
    await withServer(async (ctx) => {
      const slash = await modelOf(ctx.port, ctx.token, "sub%2Finner.html");
      const lower = await modelOf(ctx.port, ctx.token, "sub%2finner.html");

      expect(slash.status).toBe(200);
      expect(lower.status).toBe(200);
    }, richSeed);
  });

  it("should serve a Unicode filename docId (NFC over the wire)", async () => {
    await withServer(async (ctx) => {
      const response = await modelOf(ctx.port, ctx.token, "caf%C3%A9.html");

      expect(response.status).toBe(200);
    }, richSeed);
  });

  it("should treat + as a literal char in the path, never as a space", async () => {
    await withServer(async (ctx) => {
      const plus = await modelOf(ctx.port, ctx.token, "a+b.html");
      const spaced = await modelOf(ctx.port, ctx.token, "a%20b.html");

      expect(plus.status).toBe(200);
      // `a+b.html` 与 `a b.html` 是两个名字：路径里的 `+` 不解成空格。
      expect(spaced.status).toBe(404);
    }, richSeed);
  });

  it("should serve a literal-percent filename via %25", async () => {
    await withServer(async (ctx) => {
      const response = await modelOf(ctx.port, ctx.token, "a%25b.html");

      expect(response.status).toBe(200);
    }, richSeed);
  });

  it("should serve a dotfile docId (only .hreader is forbidden)", async () => {
    await withServer(async (ctx) => {
      const response = await modelOf(ctx.port, ctx.token, ".dot.html");

      expect(response.status).toBe(200);
    }, richSeed);
  });
});

describe("docId · `.hreader` 存储区", () => {
  it.each([".hreader", ".hreader%2Ftrap.html", ".hreader%2Flocks%2Fheld.lock"])(
    "should refuse docId %s with path_outside_workspace even though it exists",
    async (pathDocId) => {
      await withServer(async (ctx) => {
        const response = await modelOf(ctx.port, ctx.token, pathDocId);

        expect(response.status).toBe(403);
        expect(response.code).toBe("path_outside_workspace");
      }, storeSeed);
    },
  );

  it("should never serve .HREADER/**: 403 where realpath folds case (APFS), 404 elsewhere", async () => {
    await withServer(async (ctx) => {
      const response = await modelOf(ctx.port, ctx.token, ".HREADER%2Ftrap.html");

      // 大小写不敏感 fs：realpath 归一化出 `.hreader` → storeError 403；
      // 大小写敏感 fs：`.HREADER` 根本不存在 → 404。两条路字节都出不去。
      expect([403, 404]).toContain(response.status);
    }, storeSeed);
  });

  it("should answer 404 for a store path that does not exist (nothing to leak)", async () => {
    await withServer(async (ctx) => {
      const response = await modelOf(ctx.port, ctx.token, ".hreader%2Flocks%2Fabc.lock");

      expect(response.status).toBe(404);
    });
  });
});

describe("docId · 写路由上的穿越", () => {
  it("should refuse body.docId ../evil.html on /api/patch with path_outside_workspace", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body: appendBody("../evil.html"),
      });

      expect(response.status).toBe(403);
      expect(jsonBodyOf(response)).toMatchObject({ code: "path_outside_workspace" });
    });
  });

  it("should refuse a traversal in the path docId of a doc-scoped write route", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/..%2F..%2Fevil.html/trust",
        headers: withPost(ctx.token),
        body: JSON.stringify({ level: "local" }),
      });

      expect(response.status).toBe(403);
    });
  });

  it("should refuse body.docId that aims into .hreader on /api/patch", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body: appendBody(".hreader/trap.html"),
      });

      expect(response.status).toBe(403);
    }, storeSeed);
  });
});

describe("docId · /s/ 文档页", () => {
  it("should reject an encoded traversal docId on /s/ with 403", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/s/%2e%2e%2Fsecret.html",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(403);
    });
  });

  it("should serve a subdirectory doc page through %2F", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/s/sub%2Finner.html",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(200);
    }, richSeed);
  });
});
