// This layer owns the schema boundaries of the sidecar write bodies: strict zod —
// unknown keys die, limits come from ANCHOR_LIMITS/NOTE_LIMIT/SELECTOR_LIMITS and
// the shared 1 MiB body ceiling, and every rejection is `invalid_request` (400)
// before any op runs — so a refused write never creates a sidecar file.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ANCHOR_LIMITS, NOTE_LIMIT } from "../../src/annotations";
import { sha1Of } from "../io/harness";
import {
  cookieOf,
  defaultSeed,
  httpCall,
  withServer,
  type HttpResponse,
  type TestServer,
} from "./harness";
import { withPost } from "./wire";

const ANCHOR = { exact: "正文一", prefix: "", suffix: "", start: 0 };
const SELECTOR = "body > article:nth-of-type(1) > p:nth-of-type(1)";
const ADD = { anchor: ANCHOR, selector: SELECTOR, note: "n" };

const post = async (ctx: TestServer, tail: string, body: string): Promise<HttpResponse> =>
  httpCall(ctx.port, {
    method: "POST",
    path: `/api/doc/doc.html/sidecar${tail}`,
    headers: withPost(ctx.token),
    body,
  });

const postAdd = async (ctx: TestServer, body: unknown): Promise<HttpResponse> =>
  post(ctx, "", JSON.stringify(body));

const expectInvalid = (response: HttpResponse): void => {
  expect(response.status).toBe(400);
  expect(response.body).toContain("invalid_request");
};

const sidecarCreated = (ctx: TestServer): boolean =>
  existsSync(join(ctx.workspace, ".hreader", "annotations", `${sha1Of("doc.html")}.json`));

describe("sidecar add · body shape", () => {
  it("should refuse an extra top-level key", async () => {
    await withServer(async (ctx) => {
      const response = await postAdd(ctx, { anchor: ANCHOR, note: "n", bogus: 1 });

      expectInvalid(response);
      expect(sidecarCreated(ctx)).toBe(false);
    }, defaultSeed);
  });

  it("should refuse an extra key inside anchor", async () => {
    await withServer(async (ctx) => {
      const response = await postAdd(ctx, {
        anchor: { ...ANCHOR, bogus: 1 },
        note: "n",
      });

      expectInvalid(response);
    }, defaultSeed);
  });

  it.each(["note", "anchor"])("should refuse a missing %s", async (key) => {
    await withServer(async (ctx) => {
      const body: Record<string, unknown> = { anchor: ANCHOR, note: "n" };
      delete body[key];

      expectInvalid(await postAdd(ctx, body));
    }, defaultSeed);
  });

  it.each(["exact", "prefix", "suffix", "start"])(
    "should refuse a missing anchor.%s",
    async (key) => {
      await withServer(async (ctx) => {
        const anchor: Record<string, unknown> = { ...ANCHOR };
        delete anchor[key];

        expectInvalid(await postAdd(ctx, { anchor, note: "n" }));
      }, defaultSeed);
    },
  );

  it("should refuse an empty anchor.exact", async () => {
    await withServer(async (ctx) => {
      const response = await postAdd(ctx, {
        anchor: { ...ANCHOR, exact: "" },
        note: "n",
      });

      expectInvalid(response);
    }, defaultSeed);
  });

  it("should refuse wrong field types", async () => {
    await withServer(async (ctx) => {
      expectInvalid(await postAdd(ctx, { anchor: ANCHOR, note: 1 }));
      expectInvalid(await postAdd(ctx, { anchor: { ...ANCHOR, start: "0" }, note: "n" }));
      expectInvalid(await postAdd(ctx, { anchor: { ...ANCHOR, exact: 5 }, note: "n" }));
      expectInvalid(await postAdd(ctx, { anchor: ANCHOR, selector: 7, note: "n" }));
      expectInvalid(await postAdd(ctx, { anchor: ANCHOR, note: "n", docId: 9 }));
    }, defaultSeed);
  });

  it("should refuse a negative anchor.start", async () => {
    await withServer(async (ctx) => {
      const response = await postAdd(ctx, {
        anchor: { ...ANCHOR, start: -1 },
        note: "n",
      });

      expectInvalid(response);
    }, defaultSeed);
  });

  it("should refuse a non-object body — null, array and string alike", async () => {
    await withServer(async (ctx) => {
      for (const body of ["null", "[]", '"x"', "not json"]) {
        const response = await httpCall(ctx.port, {
          method: "POST",
          path: "/api/doc/doc.html/sidecar",
          headers: withPost(ctx.token),
          body,
        });

        expectInvalid(response);
      }
      expect(sidecarCreated(ctx)).toBe(false);
    }, defaultSeed);
  });

  it("should refuse __proto__ and constructor keys and keep Object.prototype clean", async () => {
    await withServer(async (ctx) => {
      const proto = await post(
        ctx,
        "",
        `{"__proto__":{"polluted":1},"anchor":${JSON.stringify(ANCHOR)},"note":"n"}`,
      );
      const ctor = await postAdd(ctx, {
        constructor: { polluted: 1 },
        anchor: ANCHOR,
        note: "n",
      });

      expectInvalid(proto);
      expectInvalid(ctor);
      expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
      expect(sidecarCreated(ctx)).toBe(false);
    }, defaultSeed);
  });

  it("should tolerate a matching body.docId but refuse a disagreeing one", async () => {
    await withServer(async (ctx) => {
      const ok = await postAdd(ctx, { ...ADD, docId: "doc.html" });
      const bad = await postAdd(ctx, { ...ADD, docId: "other.html" });

      expect(ok.status).toBe(201);
      expect(bad.status).toBe(400);
      expect(bad.body).toContain("invalid_payload");
    }, defaultSeed);
  });
});

describe("sidecar add · field limits", () => {
  it("should accept exact/prefix/suffix/note at their limits", async () => {
    await withServer(async (ctx) => {
      const response = await postAdd(ctx, {
        anchor: {
          exact: "x".repeat(ANCHOR_LIMITS.exact),
          prefix: "p".repeat(ANCHOR_LIMITS.prefix),
          suffix: "s".repeat(ANCHOR_LIMITS.suffix),
          start: 0,
        },
        selector: SELECTOR,
        note: "n".repeat(NOTE_LIMIT),
      });

      expect(response.status).toBe(201);
    }, defaultSeed);
  });

  it("should refuse exact/prefix/suffix/note one past their limits", async () => {
    await withServer(async (ctx) => {
      expectInvalid(
        await postAdd(ctx, {
          anchor: { ...ANCHOR, exact: "x".repeat(ANCHOR_LIMITS.exact + 1) },
          note: "n",
        }),
      );
      expectInvalid(
        await postAdd(ctx, {
          anchor: { ...ANCHOR, prefix: "p".repeat(ANCHOR_LIMITS.prefix + 1) },
          note: "n",
        }),
      );
      expectInvalid(
        await postAdd(ctx, {
          anchor: { ...ANCHOR, suffix: "s".repeat(ANCHOR_LIMITS.suffix + 1) },
          note: "n",
        }),
      );
      expectInvalid(await postAdd(ctx, { anchor: ANCHOR, note: "n".repeat(NOTE_LIMIT + 1) }));
      expect(sidecarCreated(ctx)).toBe(false);
    }, defaultSeed);
  });

  it("should refuse an oversized body at the shared 1 MiB ceiling", async () => {
    await withServer(async (ctx) => {
      const response = await post(
        ctx,
        "",
        `{"anchor":${JSON.stringify(ANCHOR)},"note":"${"n".repeat(1_048_577)}"}`,
      );

      expect(response.status).toBe(413);
      expect(sidecarCreated(ctx)).toBe(false);
    }, defaultSeed);
  });
});

describe("sidecar op bodies", () => {
  const withAnnotation = async (
    ctx: TestServer,
    run: (id: string) => Promise<void>,
  ): Promise<void> => {
    const added = await postAdd(ctx, ADD);
    expect(added.status).toBe(201);
    const id = (JSON.parse(added.body) as { id: string }).id;
    await run(id);
  };

  it("should enforce strict shapes on resolve/reopen/reply/delete", async () => {
    await withServer(async (ctx) => {
      await withAnnotation(ctx, async (id) => {
        // resolve: resolutionNote is optional but bounded.
        expectInvalid(
          await post(ctx, `/${id}/resolve`, `{"resolutionNote":"${"n".repeat(NOTE_LIMIT + 1)}"}`),
        );
        expectInvalid(await post(ctx, `/${id}/resolve`, `{"resolutionNote":5}`));
        expectInvalid(await post(ctx, `/${id}/resolve`, `{"bogus":1}`));
        expect(
          (await post(ctx, `/${id}/resolve`, `{"resolutionNote":"${"n".repeat(NOTE_LIMIT)}"}`))
            .status,
        ).toBe(200);

        // reopen/delete: only docId may ride along.
        expectInvalid(await post(ctx, `/${id}/reopen`, `{"bogus":1}`));
        expectInvalid(await post(ctx, `/${id}/delete`, `{"bogus":1}`));
        expect((await post(ctx, `/${id}/reopen`, `{}`)).status).toBe(200);

        // reply: note is required and bounded.
        expectInvalid(await post(ctx, `/${id}/reply`, `{}`));
        expectInvalid(await post(ctx, `/${id}/reply`, `{"note":5}`));
        expectInvalid(await post(ctx, `/${id}/reply`, `{"note":"${"n".repeat(NOTE_LIMIT + 1)}"}`));
        expectInvalid(await post(ctx, `/${id}/reply`, `{"note":"ok","bogus":1}`));
        expect(
          (await post(ctx, `/${id}/reply`, `{"note":"${"n".repeat(NOTE_LIMIT)}"}`)).status,
        ).toBe(200);

        expect((await post(ctx, `/${id}/delete`, `{}`)).status).toBe(200);
      });
    }, defaultSeed);
  });

  it("should accept docId on keyed writes when it agrees with the path", async () => {
    await withServer(async (ctx) => {
      await withAnnotation(ctx, async (id) => {
        const response = await post(ctx, `/${id}/resolve`, `{"docId":"doc.html"}`);

        expect(response.status).toBe(200);
      });
    }, defaultSeed);
  });
});
