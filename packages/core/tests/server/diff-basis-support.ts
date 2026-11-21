// 这层管：`annotations-diff-basis.test.ts` 用的服务器夹具——同一篇文档、同一批 patch、
// 同一个 diff 端点；用例只差别在不同历史形状，夹具不必重复写。

import { expect } from "vitest";

import { cookieOf, httpCall, jsonBodyOf, type TestServer } from "./harness";
import { withPost } from "./wire";

export const fieldOf = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;

/** 随文件进来的那条批注（`anchor.exact` 决定它在正文里挂哪儿）。 */
export interface MetaAnnotation {
  readonly id: string;
  readonly nodeId: string;
  readonly exact: string;
  readonly note: string;
}

/** 一份带 meta 脚本的文档：`body` 是正文。 */
export const docWithMeta = (body: string, annotation: MetaAnnotation): string =>
  [
    "<!doctype html>",
    "<html><head><title>t</title></head><body>",
    body,
    `<script id="hr-meta" type="application/json">${JSON.stringify({
      version: 1,
      annotations: [
        {
          id: annotation.id,
          nodeId: annotation.nodeId,
          anchor: { exact: annotation.exact, prefix: "", suffix: "", start: 0 },
          note: annotation.note,
          status: "pending",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })}</script>`,
    "</body></html>",
  ].join("\r\n");

/** 一篇自带 meta 脚本、但工作区里没有任何历史快照的文档（拷贝进来的文件就是这种形状）。 */
export const DOC_WITH_META = (annotationId: string, nodeId: string): string =>
  docWithMeta(
    `<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2><p data-hr-id="${nodeId}">正文一</p><p data-hr-id="hr-d">正文二</p></article>`,
    { id: annotationId, nodeId, exact: "正文", note: "随文件进来" },
  );

/** 正文里**没有**这条批注指向的块（用户在编辑器里删掉了它），但 meta 脚本还在。 */
export const docWithOrphanMeta = (annotationId: string, nodeId: string, note: string): string =>
  docWithMeta(
    '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2><p data-hr-id="hr-c">正文一</p></article>',
    { id: annotationId, nodeId, exact: "正文一", note },
  );

export const DOC_META_ORPHAN = docWithOrphanMeta("an-gone", "hr-gone", "块已经被删了");

export const addAt = async (ctx: TestServer, nodeId: string, note: string): Promise<string> => {
  const response = await httpCall(ctx.port, {
    method: "POST",
    path: `/api/doc/${ctx.docId}/annotations`,
    headers: withPost(ctx.token),
    body: JSON.stringify({
      docId: ctx.docId,
      nodeId,
      anchor: { exact: "正文", prefix: "", suffix: "", start: 0 },
      note,
    }),
  });
  expect(response.status).toBe(201);
  const id = fieldOf(jsonBodyOf(response), "id");
  if (typeof id !== "string") throw new Error("响应缺 id");
  return id;
};

export const patchOf = async (
  ctx: TestServer,
  action: "replace" | "delete",
  targetId: string,
  fragment?: string,
): Promise<void> => {
  const response = await httpCall(ctx.port, {
    method: "POST",
    path: "/api/patch",
    headers: withPost(ctx.token),
    body: JSON.stringify(
      action === "replace"
        ? { docId: ctx.docId, action, targetId, fragment }
        : { docId: ctx.docId, action, targetId },
    ),
  });
  expect(response.status).toBe(200);
};

export const diffOf = async (ctx: TestServer, anId: string): Promise<unknown> => {
  const response = await httpCall(ctx.port, {
    path: `/api/doc/${ctx.docId}/notes/${anId}/diff`,
    headers: { Cookie: cookieOf(ctx.token) },
  });
  expect(response.status).toBe(200);
  return jsonBodyOf(response);
};

export const chunkTextOf = (body: unknown): string => {
  const raw = fieldOf(body, "chunks");
  if (!Array.isArray(raw)) throw new Error("chunks 形状不符");
  return raw
    .map((chunk: unknown) => fieldOf(chunk, "text"))
    .filter((text): text is string => typeof text === "string")
    .join("");
};
