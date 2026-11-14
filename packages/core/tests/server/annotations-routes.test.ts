// 这层管：M2.3 的四条新路由（16 条表里的 12→16）：正例 + 未鉴权/坏载荷/未知 docId 负例。
// 走真 HTTP：断言 code 之外，负例还要断"文件字节没动"。

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readAnnotations } from "../../src/annotations";
import { sha256Of } from "../io/harness";
import { cookieOf, httpCall, jsonBodyOf, withServer, type TestServer } from "./harness";
import { withPost } from "./wire";

const ANNOTATION = {
  nodeId: "hr-c",
  anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
  note: "批注",
};

/** 写路由的 body 必须自带 `docId`（与路径段并行，见 `write-replies.ts:30`）。 */
const bodyOf = (docId: string, patch: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({ docId, ...ANNOTATION, ...patch });

const fieldOf = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;

const postTo = async (
  ctx: TestServer,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<ReturnType<typeof httpCall>> =>
  httpCall(ctx.port, {
    method: "POST",
    path,
    headers: withPost(ctx.token),
    body: JSON.stringify({ docId: ctx.docId, ...ANNOTATION, ...body }),
  });

const addOne = async (ctx: TestServer): Promise<string> => {
  const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, ANNOTATION);
  const id = fieldOf(jsonBodyOf(response), "id");
  return typeof id === "string" ? id : "";
};

describe("GET /api/doc/:doc/annotations", () => {
  it("should list annotations with revision, lost and diagnostics", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: `/api/doc/${ctx.docId}/annotations`,
        headers: { Cookie: cookieOf(ctx.token) },
      });
      const body = jsonBodyOf(response);

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ annotations: [], lost: [], diagnostics: [] });
      expect(typeof fieldOf(body, "revision")).toBe("string");
    });
  });

  it("should reject an unauthenticated read with unauthorized", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: `/api/doc/${ctx.docId}/annotations` });

      expect(response.status).toBe(401);
      expect(response.body).toContain("unauthorized");
    });
  });
});

describe("POST /api/doc/:doc/annotations · 正例", () => {
  it("should write one annotation and report its id and revision", async () => {
    await withServer(async (ctx) => {
      const before = readFileSync(ctx.file);
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, ANNOTATION);
      const body = jsonBodyOf(response);
      const [annotation] = readAnnotations(readFileSync(ctx.file, "utf8")).annotations;

      expect(response.status).toBe(201);
      expect(body).toMatchObject({ id: annotation?.id });
      expect(annotation).toMatchObject({ nodeId: "hr-c", note: "批注", status: "pending" });
      expect(sha256Of(readFileSync(ctx.file))).not.toBe(sha256Of(before));
    });
  });
});

describe("POST annotations · 鉴权与载荷拒绝", () => {
  it("should reject a missing csrf token without touching the file", async () => {
    await withServer(async (ctx) => {
      const before = sha256Of(readFileSync(ctx.file));
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: `/api/doc/${ctx.docId}/annotations`,
        headers: { Cookie: cookieOf(ctx.token) },
        body: bodyOf(ctx.docId),
      });

      expect(response.status).toBe(403);
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });
});

describe("POST annotations · 载荷与目标校验", () => {
  it("should reject a payload without anchor as invalid_payload", async () => {
    await withServer(async (ctx) => {
      const before = sha256Of(readFileSync(ctx.file));
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, {
        anchor: undefined,
      });

      expect(response.status).toBe(400);
      expect(response.body).toContain("invalid_payload");
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });

  it("should reject an unknown docId with not_found", async () => {
    await withServer(async (ctx) => {
      const response = await postTo(ctx, "/api/doc/ghost.html/annotations", {
        ...ANNOTATION,
        docId: "ghost.html",
      });

      expect(response.status).toBe(404);
      expect(response.body).toContain("not_a_file");
    });
  });
});

describe("POST .../annotations/:an/resolve", () => {
  it("should mark the annotation resolved", async () => {
    await withServer(async (ctx) => {
      const id = await addOne(ctx);
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations/${id}/resolve`, {
        resolutionNote: "好",
      });
      const [annotation] = readAnnotations(readFileSync(ctx.file, "utf8")).annotations;

      expect(response.status).toBe(200);
      expect(annotation).toMatchObject({ id, status: "resolved", resolutionNote: "好" });
    });
  });

  it("should report not_found for an unknown annotation id", async () => {
    await withServer(async (ctx) => {
      const before = sha256Of(readFileSync(ctx.file));
      const response = await postTo(
        ctx,
        `/api/doc/${ctx.docId}/annotations/an-deadbeef/resolve`,
        {},
      );

      expect(response.status).toBe(404);
      expect(response.body).toContain("not_found");
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });
});

describe("POST annotations · 载荷注入", () => {
  it("should store </script> escaped so the meta element still closes exactly once", async () => {
    await withServer(async (ctx) => {
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, {
        note: "</script><img src=x onerror=alert(1)>",
      });
      const html = readFileSync(ctx.file, "utf8");

      expect(response.status).toBe(201);
      expect(html.match(/<\/script>/gu)).toHaveLength(1);
      expect(readAnnotations(html).annotations[0]?.note).toBe(
        "</script><img src=x onerror=alert(1)>",
      );
    });
  });

  it("should treat ../../etc/passwd as literal text, not a path", async () => {
    await withServer(async (ctx) => {
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, {
        anchor: { exact: "../../etc/passwd", prefix: "", suffix: "", start: 0 },
      });

      expect(response.status).toBe(201);
      expect(readAnnotations(readFileSync(ctx.file, "utf8")).annotations[0]?.anchor.exact).toBe(
        "../../etc/passwd",
      );
    });
  });
});

describe("POST /api/doc/:doc/undo", () => {
  it("should rethrow a real failure instead of masking it as nothing_to_undo", async () => {
    await withServer(async (ctx) => {
      await addOne(ctx);
      // 把快照内容改坏：哈希不符就是 `io_failure`，**不能**被翻成 `nothing_to_undo`（那会让人误去重写）。
      const historyDir = join(ctx.workspace, ".hreader", "history");
      const [bucket] = readdirSync(historyDir);
      const bucketDir = join(historyDir, bucket ?? "");
      const [snapshot] = readdirSync(bucketDir);
      writeFileSync(join(bucketDir, snapshot ?? ""), "坏掉的内容");
      const before = sha256Of(readFileSync(ctx.file));

      const response = await postTo(ctx, `/api/doc/${ctx.docId}/undo`, {});

      expect(response.status).toBe(500);
      expect(response.body).toContain("io_failure");
      expect(response.body).not.toContain("nothing_to_undo");
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });

  it("should report nothing_to_undo on a document with no history", async () => {
    await withServer(async (ctx) => {
      const before = sha256Of(readFileSync(ctx.file));
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/undo`, {});

      expect(response.status).toBe(409);
      expect(response.body).toContain("nothing_to_undo");
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });
});

describe("POST /api/doc/:doc/undo · 恢复", () => {
  it("should restore the pre-annotation bytes", async () => {
    await withServer(async (ctx) => {
      const before = sha256Of(readFileSync(ctx.file));
      await addOne(ctx);
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/undo`, {});

      expect(response.status).toBe(200);
      expect(jsonBodyOf(response)).toHaveProperty("revision");
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });
});

describe("POST /api/doc/:doc/annotations · 载荷边界", () => {
  it("should default the note to an empty string when the body omits it", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: `/api/doc/${ctx.docId}/annotations`,
        headers: withPost(ctx.token),
        body: JSON.stringify({
          docId: ctx.docId,
          nodeId: "hr-c",
          anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
        }),
      });

      expect(response.status).toBe(201);
      const listed = readAnnotations(readFileSync(ctx.file, "utf8"));
      expect(listed.annotations.map((item) => item.note)).toEqual([""]);
    });
  });

  it("should reject a body docId that disagrees with the path", async () => {
    await withServer(async (ctx) => {
      const before = sha256Of(readFileSync(ctx.file));

      const response = await httpCall(ctx.port, {
        method: "POST",
        path: `/api/doc/${ctx.docId}/annotations`,
        headers: withPost(ctx.token),
        body: bodyOf("other.html"),
      });

      // 裁定 #6：路径段是唯一真相，body 不一致要报错，而不是静默用其中一个。
      expect(response.status).toBe(400);
      expect(response.body).toContain("invalid_payload");
      expect(response.body).toContain("body.docId");
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });
});
