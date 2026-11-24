// 这层管：`GET /api/doc/:docId/info`——三档文档各自的 `{revision, cls, reason?, kind?}` 形状与鉴权。

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, defaultSeed, httpCall, jsonBodyOf, withServer } from "./harness";

interface InfoBody {
  readonly cls?: string;
  readonly reason?: string;
  readonly kind?: string;
  readonly revision?: string;
  readonly code?: string;
}

const foreignHtml = (workspace: string): void => {
  defaultSeed(workspace);
  writeFileSync(
    join(workspace, "doc.html"),
    '<!doctype html><html><body><div class="app"><script>window.x=1</script></div></body></html>',
    "utf8",
  );
};

const seedWith =
  (html: string) =>
  (workspace: string): void => {
    defaultSeed(workspace);
    writeFileSync(join(workspace, "doc.html"), html, "utf8");
  };

const infoOf = async (
  port: number,
  token: string,
  docId = "doc.html",
): Promise<{ status: number; body: InfoBody }> => {
  const response = await httpCall(port, {
    path: `/api/doc/${docId}/info`,
    headers: { cookie: cookieOf(token) },
  });
  return { status: response.status, body: jsonBodyOf(response) as InfoBody };
};

describe("doc info · managed", () => {
  it("should report cls managed with revision and no reason/kind", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await infoOf(ctx.port, ctx.token);

      expect(status).toBe(200);
      expect(body.cls).toBe("managed");
      expect(body.revision).toMatch(/^[0-9a-f]{16}$/u);
      expect(body.reason).toBeUndefined();
      expect(body.kind).toBeUndefined();
    });
  });

  it("should report kind when the article carries a valid data-hr-kind", async () => {
    await withServer(async (ctx) => {
      const { body } = await infoOf(ctx.port, ctx.token);

      expect(body.cls).toBe("managed");
      expect(body.kind).toBe("report");
    }, seedWith('<article data-hr-id="hr-a" data-hr-kind="report"><p>x</p></article>'));
  });

  it("should omit kind when data-hr-kind is not a known doc kind", async () => {
    await withServer(async (ctx) => {
      const { body } = await infoOf(ctx.port, ctx.token);

      expect(body.cls).toBe("managed");
      expect(body.kind).toBeUndefined();
    }, seedWith('<article data-hr-id="hr-a" data-hr-kind="bogus"><p>x</p></article>'));
  });
});

describe("doc info · normalizable", () => {
  it("should report cls normalizable without a reason", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await infoOf(ctx.port, ctx.token);

      expect(status).toBe(200);
      expect(body.cls).toBe("normalizable");
      expect(body.reason).toBeUndefined();
    }, seedWith("<article><p>没有 id</p></article>"));
  });
});

describe("doc info · foreign", () => {
  it("should report cls foreign with a human-readable reason", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await infoOf(ctx.port, ctx.token);

      expect(status).toBe(200);
      expect(body.cls).toBe("foreign");
      expect(body.reason).toContain("<article>");
      expect(body.kind).toBeUndefined();
    }, foreignHtml);
  });
});

describe("doc info · 边界", () => {
  it("should answer 404 not_a_file for a missing document", async () => {
    await withServer(async (ctx) => {
      const { status, body } = await infoOf(ctx.port, ctx.token, "nope.html");

      expect(status).toBe(404);
      expect(body.code).toBe("not_a_file");
    });
  });

  it("should require the cookie like every other GET api route", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: "/api/doc/doc.html/info" });

      expect(response.status).toBe(401);
    });
  });
});
