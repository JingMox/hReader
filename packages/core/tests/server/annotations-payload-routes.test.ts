// 这层管：批注载荷的边界（NUL/超长）、`lost` 判定、anchor 结构校验、resolve 的可选字段。
// 从 `annotations-routes.test.ts` 拆出来（那个文件已到 300 行上限），断言口径完全一致。

import { readFileSync } from "node:fs";

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

describe("POST annotations · NUL 与超长", () => {
  it("should round-trip a NUL byte inside the note", async () => {
    await withServer(async (ctx) => {
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, {
        note: "前\u0000后",
      });

      expect(response.status).toBe(201);
      expect(readAnnotations(readFileSync(ctx.file, "utf8")).annotations[0]?.note).toBe(
        "前\u0000后",
      );
    });
  });

  it("should reject a 100k note with invalid_payload and keep the file", async () => {
    await withServer(async (ctx) => {
      const before = sha256Of(readFileSync(ctx.file));
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, {
        note: "n".repeat(100_000),
      });

      expect(response.status).toBe(400);
      expect(response.body).toContain("invalid_payload");
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });
});

describe("GET annotations · lost 计算", () => {
  it("should mark an annotation whose block is gone as lost", async () => {
    await withServer(async (ctx) => {
      await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, {
        ...ANNOTATION,
        nodeId: "hr-ghost",
      });
      const response = await httpCall(ctx.port, {
        path: `/api/doc/${ctx.docId}/annotations`,
        headers: { Cookie: cookieOf(ctx.token) },
      });
      const body = jsonBodyOf(response);

      // 先证明 nodeId 原样落盘（不被悄悄改写成 ""），否则下面的 orphaned 断言可能走的是别的分支。
      expect(
        readAnnotations(readFileSync(ctx.file, "utf8")).annotations.map((it) => it.nodeId),
      ).toEqual(["hr-ghost"]);
      expect(fieldOf(body, "lost")).toHaveLength(1);
      expect(fieldOf(body, "annotations")).toHaveLength(1);
    });
  });
});

describe("POST annotations · anchor 结构校验", () => {
  it("should reject a string anchor with invalid_payload", async () => {
    await withServer(async (ctx) => {
      const before = sha256Of(readFileSync(ctx.file));
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, {
        anchor: "正文",
      });

      expect(response.status).toBe(400);
      expect(response.body).toContain("invalid_payload");
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });

  it("should default prefix/suffix to empty when only exact and start are sent", async () => {
    await withServer(async (ctx) => {
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations`, {
        anchor: { exact: "正文一", start: 0 },
      });
      const [annotation] = readAnnotations(readFileSync(ctx.file, "utf8")).annotations;

      expect(response.status).toBe(201);
      expect(annotation?.anchor).toEqual({ exact: "正文一", prefix: "", suffix: "", start: 0 });
    });
  });
});

describe("POST .../resolve · 无备注", () => {
  it("should resolve without a resolutionNote", async () => {
    await withServer(async (ctx) => {
      const id = await addOne(ctx);
      const response = await postTo(ctx, `/api/doc/${ctx.docId}/annotations/${id}/resolve`, {});
      const [annotation] = readAnnotations(readFileSync(ctx.file, "utf8")).annotations;

      expect(response.status).toBe(200);
      expect(annotation?.status).toBe("resolved");
      expect(annotation?.resolutionNote).toBeUndefined();
    });
  });
});

describe("POST /api/doc/:docId · body 省略 docId（浏览器端真请求形状）", () => {
  it("should accept annotation add and undo when docId comes only from URL path", async () => {
    await withServer(async (ctx) => {
      const before = sha256Of(readFileSync(ctx.file));
      const addRes = await httpCall(ctx.port, {
        method: "POST",
        path: `/api/doc/${ctx.docId}/annotations`,
        headers: withPost(ctx.token),
        body: JSON.stringify(ANNOTATION),
      });
      const undoRes = await httpCall(ctx.port, {
        method: "POST",
        path: `/api/doc/${ctx.docId}/undo`,
        headers: withPost(ctx.token),
        body: "{}",
      });

      expect(addRes.status).toBe(201);
      expect(undoRes.status).toBe(200);
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });
});
