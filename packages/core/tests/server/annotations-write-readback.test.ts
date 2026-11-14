// D.1（P0）：写入成功但读不回来 = 批注当场丢。
// 写路径与读路径对"必填字段"的判断一旦分叉（如写时不落 `createdAt`），`POST` 依旧 201，
// 而 `GET /annotations` 会把这张卡当脏数据跳过（`annotations[0] 缺少 createdAt，已跳过`）。
// 这里走真实用户流程：同一台服务器上写完立刻读列表，断言能读回同一张卡。

import { describe, expect, it } from "vitest";

import {
  cookieOf,
  httpCall,
  jsonBodyOf,
  withServer,
  type HttpResponse,
  type TestServer,
} from "./harness";
import { withPost } from "./wire";

const fieldOf = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;

const ANNOTATION = {
  nodeId: "hr-c",
  anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
  note: "批注",
};

const postNote = async (ctx: TestServer): Promise<HttpResponse> =>
  httpCall(ctx.port, {
    method: "POST",
    path: `/api/doc/${ctx.docId}/annotations`,
    headers: withPost(ctx.token),
    body: JSON.stringify({ docId: ctx.docId, ...ANNOTATION }),
  });

interface Listed {
  readonly status: number;
  readonly body: unknown;
  readonly cards: readonly unknown[];
}

const listNotes = async (ctx: TestServer): Promise<Listed> => {
  const response = await httpCall(ctx.port, {
    path: `/api/doc/${ctx.docId}/annotations`,
    headers: { Cookie: cookieOf(ctx.token) },
  });
  const body = jsonBodyOf(response);
  const raw = fieldOf(body, "annotations");
  return { status: response.status, body, cards: Array.isArray(raw) ? raw : [] };
};

describe("写批注 → 读列表 · 往返（D.1）", () => {
  it("should read back the annotation it just wrote, createdAt included", async () => {
    await withServer(async (ctx) => {
      const created = await postNote(ctx);
      const createdId = fieldOf(jsonBodyOf(created), "id");

      const listed = await listNotes(ctx);
      const [card] = listed.cards;

      expect(created.status).toBe(201);
      expect(listed.status).toBe(200);
      expect(fieldOf(listed.body, "diagnostics")).toEqual([]);
      expect(fieldOf(card, "id")).toBe(createdId);
      expect(fieldOf(card, "note")).toBe("批注");
      expect(typeof fieldOf(card, "createdAt")).toBe("string");
    });
  });
});
