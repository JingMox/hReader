// This layer covers `GET /api/doc/<docId>/thumb` over a real server + real
// sockets: cookie auth (401 / `Origin: null` 403), the etag/304 contract, the
// injected-renderer seam (absent → the export pipeline's no-Chrome body;
// throwing → the four render codes as JSON), 404 for unknown docs, and the
// `.hreader/**` refusal the route inherits from `resolveTarget`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HrError, type ThumbRender, type ThumbRequest } from "../../src/index";
import { cookieOf, httpCall, withServer } from "./harness";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x02, 0x58, 0x00, 0x00, 0x01, 0x90, 0x08, 0x02, 0x00, 0x00, 0x00,
]);

const etagOf = (file: string): string =>
  `"${createHash("sha256").update(readFileSync(file)).digest("hex")}"`;

const renderOK: ThumbRender = () => Promise.resolve(PNG);

const withThumb = async (
  thumb: ThumbRender | undefined,
  run: (ctx: { port: number; token: string; file: string; workspace: string }) => Promise<void>,
): Promise<void> =>
  withServer(
    async (ctx) => {
      await run(ctx);
    },
    undefined,
    undefined,
    thumb === undefined ? {} : { thumb },
  );

const get = (
  port: number,
  token: string | undefined,
  path: string,
  headers: Record<string, string> = {},
) =>
  httpCall(port, {
    path,
    headers: token === undefined ? headers : { cookie: cookieOf(token), ...headers },
  });

describe("GET /api/doc/<docId>/thumb · auth", () => {
  it("should answer 401 without a cookie", async () => {
    await withThumb(renderOK, async (ctx) => {
      const response = await get(ctx.port, undefined, "/api/doc/doc.html/thumb");
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({ code: "unauthorized" });
    });
  });

  it("should answer 403 for `Origin: null` (thumb is a cookie route, not a capability one)", async () => {
    await withThumb(renderOK, async (ctx) => {
      const response = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb", {
        origin: "null",
      });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ code: "forbidden_origin" });
    });
  });
});

describe("GET /api/doc/<docId>/thumb · success", () => {
  it("should serve image/png with the hash etag and revalidation cache-control", async () => {
    await withThumb(renderOK, async (ctx) => {
      const response = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["cache-control"]).toBe("private, max-age=0, must-revalidate");
      expect(response.headers["etag"]).toBe(etagOf(ctx.file));
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      // httpCall utf8-decodes the body; decoding the same bytes is deterministic, so compare decodings.
      expect(response.body).toBe(PNG.toString("utf8"));
    });
  });

  it("should hand the renderer the resolved path and the content hash", async () => {
    const requests: ThumbRequest[] = [];
    await withThumb(
      async (request) => {
        requests.push(request);
        return await Promise.resolve(PNG);
      },
      async (ctx) => {
        await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.path).toBe(ctx.file);
        expect(requests[0]?.hash).toBe(etagOf(ctx.file).slice(1, -1));
      },
    );
  });
});

describe("GET /api/doc/<docId>/thumb · etag/304", () => {
  it("should answer 304 on If-None-Match without calling the renderer", async () => {
    let renders = 0;
    const render: ThumbRender = async () => {
      renders += 1;
      return await Promise.resolve(PNG);
    };
    await withThumb(render, async (ctx) => {
      const etag = etagOf(ctx.file);
      const response = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb", {
        "if-none-match": etag,
      });

      expect(response.status).toBe(304);
      expect(response.headers["etag"]).toBe(etag);
      expect(response.body).toBe("");
      expect(renders).toBe(0);
    });
  });

  it("should match the etag inside a list and honor a weak tag, but render on a mismatch", async () => {
    await withThumb(renderOK, async (ctx) => {
      const etag = etagOf(ctx.file);
      const weak = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb", {
        "if-none-match": `"other", W/${etag}`,
      });
      expect(weak.status).toBe(304);

      const miss = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb", {
        "if-none-match": '"different"',
      });
      expect(miss.status).toBe(200);
    });
  });

  it("should answer 304 on the `*` wildcard — any representation matches", async () => {
    let renders = 0;
    const render: ThumbRender = async () => {
      renders += 1;
      return await Promise.resolve(PNG);
    };
    await withThumb(render, async (ctx) => {
      const response = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb", {
        "if-none-match": "*",
      });
      expect(response.status).toBe(304);
      expect(renders).toBe(0);
    });
  });
});

describe("GET /api/doc/<docId>/thumb · renderer errors", () => {
  it("should answer the export pipeline's no-Chrome body when no renderer is injected", async () => {
    await withThumb(undefined, async (ctx) => {
      const response = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb");
      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toMatchObject({
        code: "chrome_missing",
        message: expect.stringContaining("缩略图渲染器不可用") as string,
      });
    });
  });

  it.each(["chrome_missing", "chrome_failed", "render_timeout", "render_empty"] as const)(
    "should translate a thrown %s into the JSON error body",
    async (code) => {
      await withThumb(
        () => Promise.reject(new HrError(code, "boom")),
        async (ctx) => {
          const response = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb");
          expect(response.status).toBe(500);
          // The render code AND the sanitized message ride the body — a blanked
          // publicMessageOf would leave `message` empty.
          expect(JSON.parse(response.body)).toMatchObject({
            code,
            message: expect.stringContaining("boom") as string,
          });
        },
      );
    },
  );

  it("should rethrow a non-render error so errorReply's status table handles it", async () => {
    await withThumb(
      () => Promise.reject(new HrError("io_failure", "disk gone")),
      async (ctx) => {
        const response = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb");
        expect(response.status).toBe(500);
        // errorReply's fixed io_failure copy — NOT the thrown message — proves
        // the rethrow path ran (renderErrorReply would echo the raw message).
        expect(JSON.parse(response.body)).toMatchObject({
          code: "io_failure",
          message: "服务端暂时不可用",
        });
      },
    );
  });

  it("should rethrow a non-HrError even when it carries a render-looking code field", async () => {
    await withThumb(
      () => Promise.reject(Object.assign(new Error("plain"), { code: "chrome_failed" })),
      async (ctx) => {
        const response = await get(ctx.port, ctx.token, "/api/doc/doc.html/thumb");
        expect(response.status).toBe(500);
        // Not an HrError → never the render translation; the generic internal-error body.
        expect(JSON.parse(response.body)).toMatchObject({
          code: "io_failure",
          message: "服务端内部错误",
        });
      },
    );
  });
});

describe("GET /api/doc/<docId>/thumb · target resolution", () => {
  it("should answer 404 for an unknown document", async () => {
    await withThumb(renderOK, async (ctx) => {
      const response = await get(ctx.port, ctx.token, "/api/doc/nope.html/thumb");
      expect(response.status).toBe(404);
    });
  });

  it("should refuse a `.hreader/**` docId like every other doc route", async () => {
    await withThumb(renderOK, async (ctx) => {
      const response = await get(ctx.port, ctx.token, "/api/doc/.hreader%2Fthumbs%2Fx.png/thumb");
      expect([400, 403, 404]).toContain(response.status);
      expect(response.status).not.toBe(200);
    });
  });
});
