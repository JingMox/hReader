// 这层管：裁定 #8 挪到服务端的 diff 路由 `GET /api/doc/<docId>/notes/<anId>/diff`（路由表第 17 条）。
// 只断"服务端真的算了 diff"：chunk 能逐字重拼出 before/after，边界是"没有历史 → before 为空"。
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TextChunk } from "../../src/annotations";
import { sha256Of } from "../io/harness";
import {
  cookieOf,
  httpCall,
  jsonBodyOf,
  withServer,
  type HttpResponse,
  type TestServer,
} from "./harness";
import { withPost } from "./wire";

const ANNOTATION = {
  nodeId: "hr-c",
  anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
  note: "批注",
};

const fieldOf = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;

const stringFieldOf = (body: unknown, key: string): string => {
  const value = fieldOf(body, key);
  return typeof value === "string" ? value : `<missing:${key}>`;
};

const isChunk = (value: unknown): value is TextChunk => {
  const kind = fieldOf(value, "kind");
  return (
    typeof fieldOf(value, "text") === "string" &&
    (kind === "ins" || kind === "del" || kind === "same")
  );
};

/** 响应里的 chunk 数组：形状不对就在这里炸，而不是留一坨 `as` 到断言里。 */
const chunksOf = (body: unknown): readonly TextChunk[] => {
  const raw = fieldOf(body, "chunks");
  if (!Array.isArray(raw) || !raw.every(isChunk)) throw new Error("chunks 形状不符");
  return raw;
};

/** chunk 的重拼规则：`del` 属于 before、`ins`/`same` 属于 after，两侧都要逐字还原。 */
const rebuild = (chunks: readonly TextChunk[], side: "before" | "after"): string =>
  chunks
    .filter((chunk) => (side === "before" ? chunk.kind !== "ins" : chunk.kind !== "del"))
    .map((chunk) => chunk.text)
    .join("");

const addOne = async (ctx: TestServer): Promise<string> => {
  const response = await httpCall(ctx.port, {
    method: "POST",
    path: `/api/doc/${ctx.docId}/annotations`,
    headers: withPost(ctx.token),
    body: JSON.stringify({ docId: ctx.docId, ...ANNOTATION }),
  });
  expect(response.status).toBe(201);
  return stringFieldOf(jsonBodyOf(response), "id");
};

/** 先改一次正文（写下一份快照），好让"上一 revision"与当前真的不同。 */
const patchBody = async (ctx: TestServer): Promise<void> => {
  const response = await httpCall(ctx.port, {
    method: "POST",
    path: "/api/patch",
    headers: withPost(ctx.token),
    body: JSON.stringify({
      docId: ctx.docId,
      action: "replace",
      targetId: "hr-c",
      fragment: '<p data-hr-id="hr-c">新正文</p>',
    }),
  });
  expect(response.status).toBe(200);
};

const diffOf = async (ctx: TestServer, anId: string): Promise<HttpResponse> =>
  await httpCall(ctx.port, {
    path: `/api/doc/${ctx.docId}/notes/${anId}/diff`,
    headers: { Cookie: cookieOf(ctx.token) },
  });

interface ChangedDiff {
  readonly anId: string;
  readonly body: unknown;
}

/** 打一次 patch 再取 diff：正常路径的用例共用这段前置。 */
const changedDiff = async (ctx: TestServer): Promise<ChangedDiff> => {
  const anId = await addOne(ctx);
  await patchBody(ctx);
  const response = await diffOf(ctx, anId);
  expect(response.status).toBe(200);
  return { anId, body: jsonBodyOf(response) };
};

describe("GET …/diff · 正常路径", () => {
  it("should diff the current revision against the newest snapshot", async () => {
    await withServer(async (ctx) => {
      const { body } = await changedDiff(ctx);
      const chunks = chunksOf(body);

      expect(rebuild(chunks, "after")).toBe(fieldOf(body, "after"));
      expect(rebuild(chunks, "before")).toBe(fieldOf(body, "before"));
      expect(String(fieldOf(body, "before"))).toContain("正文一");
      expect(String(fieldOf(body, "after"))).toContain("新正文");
      // 裁定：块被改写导致 ID 重建 ⇒ 即使文本可比，也必须声明降级并给出原因。
      expect(fieldOf(body, "degraded")).toBe(true);
      expect(fieldOf(body, "reason")).toBe("block_reidentified");
      expect(typeof fieldOf(body, "revision")).toBe("string");
    });
  });

  it("should leave the file byte-identical when only reading the diff", async () => {
    await withServer(async (ctx) => {
      const { anId, body } = await changedDiff(ctx);
      const beforeRead = sha256Of(readFileSync(ctx.file));

      const again = await diffOf(ctx, anId);

      expect(again.status).toBe(200);
      // 两次读同一份历史 → 同一份 diff；文件也没被读操作改动。
      expect(chunksOf(jsonBodyOf(again))).toEqual(chunksOf(body));
      expect(sha256Of(readFileSync(ctx.file))).toBe(beforeRead);
    });
  });
});

describe("GET …/diff · 边界与错误", () => {
  it("should use an empty before when the document has no history at all", async () => {
    await withServer(async (ctx) => {
      const anId = await addOne(ctx);
      // 把快照全删掉：`previousTextOf` 必须给出空串（而不是抛错或拿当前稿冒充历史）。
      rmSync(join(ctx.workspace, ".hreader", "history"), { recursive: true, force: true });
      const before = sha256Of(readFileSync(ctx.file));

      const response = await diffOf(ctx, anId);
      const body = jsonBodyOf(response);
      const chunks = chunksOf(body);

      expect(response.status).toBe(200);
      expect(fieldOf(body, "before")).toBe("");
      expect(rebuild(chunks, "before")).toBe("");
      expect(rebuild(chunks, "after")).toBe(fieldOf(body, "after"));
      // 全文都算“插入”：退化也必须是 ins/same，不能出现 del。
      expect(chunks.some((chunk) => chunk.kind === "del")).toBe(false);
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });

  it("should report not_found for an unknown annotation id without touching the file", async () => {
    await withServer(async (ctx) => {
      await addOne(ctx);
      const before = sha256Of(readFileSync(ctx.file));

      const response = await diffOf(ctx, "an-00000000");

      expect(response.status).toBe(404);
      expect(response.body).toContain("not_found");
      expect(sha256Of(readFileSync(ctx.file))).toBe(before);
    });
  });
});

describe("GET …/diff · 鉴权与未知文档", () => {
  it("should reject an unauthenticated diff read", async () => {
    await withServer(async (ctx) => {
      const anId = await addOne(ctx);

      const response = await httpCall(ctx.port, {
        path: `/api/doc/${ctx.docId}/notes/${anId}/diff`,
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain("unauthorized");
    });
  });

  it("should report not_a_file for an unknown docId", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: `/api/doc/missing.html/notes/an-1/diff`,
        headers: { Cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(404);
      expect(response.body).toContain("not_a_file");
    });
  });
});
