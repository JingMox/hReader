// 这层管：`annotation-basis.ts` 的三档判定里**没有快照可用**的两条边——它们决定用户看到的是
// "整块都是新增"还是"块没了"。
//
// 为什么值得单独钉：`degradedReason` 是直接显示给人看的一句话，档位拿错时用户会被告知
// "历史里找不到该块"（正确是"看不出变化"）或者反过来看到一片绿 diff 却不知道基版缺失。
// 这两条都只在历史被裁空 / 从未写过历史时出现，靠常规"改一次块再 diff"的路径永远走不到。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, httpCall, jsonBodyOf, withServer, type TestServer } from "./harness";
import { withPost } from "./wire";

const fieldOf = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;

/** 一篇自带 meta 脚本、但工作区里没有任何历史快照的文档（拷贝进来的文件就是这种形状）。 */
const DOC_WITH_META = (annotationId: string, nodeId: string): string =>
  [
    "<!doctype html>",
    "<html><head><title>t</title></head><body>",
    '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
    `<p data-hr-id="${nodeId}">正文一</p><p data-hr-id="hr-d">正文二</p></article>`,
    `<script id="hr-meta" type="application/json">${JSON.stringify({
      version: 1,
      annotations: [
        {
          id: annotationId,
          nodeId,
          anchor: { exact: "正文", prefix: "", suffix: "", start: 0 },
          note: "随文件进来",
          status: "pending",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })}</script>`,
    "</body></html>",
  ].join("\r\n");

/** 正文里**没有**这条批注指向的块（用户在编辑器里删掉了它），但 meta 脚本还在。 */
const DOC_META_ORPHAN = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2><p data-hr-id="hr-c">正文一</p></article>',
  `<script id="hr-meta" type="application/json">${JSON.stringify({
    version: 1,
    annotations: [
      {
        id: "an-gone",
        nodeId: "hr-gone",
        anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
        note: "块已经被删了",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  })}</script>`,
  "</body></html>",
].join("\r\n");

const addAt = async (ctx: TestServer, nodeId: string, note: string): Promise<string> => {
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

const patchOf = async (
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

const diffOf = async (ctx: TestServer, anId: string): Promise<unknown> => {
  const response = await httpCall(ctx.port, {
    path: `/api/doc/${ctx.docId}/notes/${anId}/diff`,
    headers: { Cookie: cookieOf(ctx.token) },
  });
  expect(response.status).toBe(200);
  return jsonBodyOf(response);
};

const chunkTextOf = (body: unknown): string => {
  const raw = fieldOf(body, "chunks");
  if (!Array.isArray(raw)) throw new Error("chunks 形状不符");
  return raw
    .map((chunk: unknown) => fieldOf(chunk, "text"))
    .filter((text): text is string => typeof text === "string")
    .join("");
};

describe("diff 基版 · 历史为空", () => {
  it("should give only the current block text when the workspace has no snapshot at all", async () => {
    // 没有基版就没有"变化"可言：`before` 空串、`degraded:false`，除非实现自己造了个假基版。
    await withServer(
      async (ctx) => {
        const body = await diffOf(ctx, "an-selfseeded");

        expect(fieldOf(body, "nodeId")).toBe("hr-c");
        expect(fieldOf(body, "before")).toBe("");
        expect(fieldOf(body, "degraded")).toBe(false);
        expect(fieldOf(body, "reason")).toBeUndefined();
        expect(chunkTextOf(body)).toBe("正文一");
      },
      (workspace) => {
        writeFileSync(join(workspace, "doc.html"), DOC_WITH_META("an-selfseeded", "hr-c"), "utf8");
      },
    );
  });
});

describe("diff 基版 · 基版取哪一份", () => {
  it("should take before from the annotated block itself, not from whatever now sits in that slot", async () => {
    // 槽位被换成另一种标签后，最新快照同一位置上的文本已经不是这条批注的正文了；
    // 拿它当基版等于给用户看一份"别人的改动"。
    await withServer(async (ctx) => {
      const anId = await addAt(ctx, "hr-c", "主批注");
      await patchOf(ctx, "replace", "hr-c", "<h2>左块改</h2>");
      // 只换标签、不删兄弟：删掉前一个兄弟会让后续元素整体前移，“同位置 + 同 tag”那条
      // 位置兜底就会把前移过来的段落当成这块（那是它本身的口径，不是本用例要证的事）。
      await patchOf(ctx, "replace", "hr-b", "<p>标题改</p>");

      const body = await diffOf(ctx, anId);

      expect(fieldOf(body, "nodeId")).toBe("hr-c");
      expect(fieldOf(body, "before")).toBe("正文一");
      expect(fieldOf(body, "after")).toBe("");
      // C1/L-05：wire 不再有 reason/originNodeId；degraded 才是契约。
      expect(fieldOf(body, "reason")).toBeUndefined();
      expect(fieldOf(body, "degraded")).toBe(true);
      expect(typeof fieldOf(body, "degradedReason")).toBe("string");
    });
  });
});

/** 缩进一层与顶层的两个 `p`：同 tag、同样的"第几个段落"，只差嵌套层。 */
const DOC_NESTED = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><blockquote data-hr-id="hr-quote"><p data-hr-id="hr-deep">深块</p></blockquote>',
  '<p data-hr-id="hr-shallow">浅块</p></article>',
  "</body></html>",
].join("\r\n");

describe("diff 基版 · 批注指向的块在工作区外被删掉", () => {
  it("should report block_missing when the block is gone and no snapshot exists", async () => {
    // 裁定 B：用户在 hreader 之外编辑文件、把带批注的块删了，而工作区还没生成任何快照。
    // 两侧都没有文本可比（`before`/`after` 都是空串），但这**不是**"没有变化"——
    // 块已经不存在了，必须按 `block_missing` 降级告知。
    await withServer(
      async (ctx) => {
        const body = await diffOf(ctx, "an-gone");

        expect(fieldOf(body, "nodeId")).toBe("hr-gone");
        expect(fieldOf(body, "before")).toBe("");
        expect(fieldOf(body, "after")).toBe("");
        // C1/L-05：wire 不再有 reason/originNodeId；degraded 才是契约。
        expect(fieldOf(body, "reason")).toBeUndefined();
        expect(fieldOf(body, "degraded")).toBe(true);
        expect(chunkTextOf(body)).toBe("");
      },
      (workspace) => {
        writeFileSync(join(workspace, "doc.html"), DOC_META_ORPHAN, "utf8");
      },
    );
  });
});

describe("diff 基版 · 同 tag 但不同层", () => {
  it("should not hand a shallow block the identity of a deleted nested one", async () => {
    // 位置兜底里 `depth` 的那一半：只比 tag 会把"原来的深块"认成"前移上来的浅块"，
    // 用户会在一条批注上看到别人的正文。删掉 `depth` 判定这条必须红。
    await withServer(
      async (ctx) => {
        const anId = await addAt(ctx, "hr-deep", "深块批注");
        await patchOf(ctx, "replace", "hr-quote", "<p>浅替</p>");

        const body = await diffOf(ctx, anId);

        expect(fieldOf(body, "nodeId")).toBe("hr-deep");
        // C1/L-05：wire 不再有 reason/originNodeId；degraded 才是契约。
        expect(fieldOf(body, "reason")).toBeUndefined();
        expect(fieldOf(body, "degraded")).toBe(true);
        expect(fieldOf(body, "before")).toBe("深块");
      },
      (workspace) => {
        writeFileSync(join(workspace, "doc.html"), DOC_NESTED, "utf8");
      },
    );
  });
});

describe("diff 基版 · 块在正文里但历史里没有", () => {
  it("should report block_missing when the block only exists in the current file", async () => {
    // 手改文件（拷进一段带 `data-hr-id` 的旧标记）会让"正文里有、历史里没有"同时成立：
    // 这时没有基版可比，但也不能说"没有变化"——必须报缺基版，且 `before` 是空串而不是正文本身。
    await withServer(async (ctx) => {
      const anId = await addAt(ctx, "hr-c", "主批注");
      await patchOf(ctx, "replace", "hr-c", "<h2>左块改</h2>");
      await patchOf(ctx, "replace", "hr-d", "<p>正文二改</p>");
      const current = readFileSync(ctx.file, "utf8");
      expect(current).not.toContain('data-hr-id="hr-c"');
      writeFileSync(
        ctx.file,
        current.replace("<h2", '<p data-hr-id="hr-c">手改回来的块</p><h2'),
        "utf8",
      );

      const body = await diffOf(ctx, anId);

      expect(fieldOf(body, "nodeId")).toBe("hr-c");
      expect(fieldOf(body, "before")).toBe("");
      expect(fieldOf(body, "degraded")).toBe(true);
      // C1/L-05：wire 不再有 reason/originNodeId；degraded 才是契约。
      expect(fieldOf(body, "reason")).toBeUndefined();
      expect(fieldOf(body, "degradedReason")).toBe("历史里找不到该块");
      expect(chunkTextOf(body)).toBe("手改回来的块");
    });
  });
});

describe("diff 基版 · 历史被裁空", () => {
  it("should report block_missing once every snapshot containing the block has been pruned", async () => {
    // 长跑文档的真实形状：块删掉之后又写了十几次，`HISTORY_LIMIT` 把带块的那份挤掉了。
    // 此时没有任何快照认领这个 id——不能崩，也不能假装重识别成功。
    await withServer(async (ctx) => {
      const anId = await addAt(ctx, "hr-c", "主批注");
      await patchOf(ctx, "delete", "hr-c");
      for (let index = 0; index < 10; index += 1) {
        await addAt(ctx, "hr-d", `填充批注 ${String(index)}`);
      }

      const body = await diffOf(ctx, anId);

      expect(fieldOf(body, "nodeId")).toBe("hr-c");
      // C1/L-05：wire 不再有 reason/originNodeId；degraded 才是契约。
      expect(fieldOf(body, "originNodeId")).toBeUndefined();
      expect(fieldOf(body, "before")).toBe("");
      expect(fieldOf(body, "after")).toBe("");
      expect(fieldOf(body, "reason")).toBeUndefined();
      expect(fieldOf(body, "degraded")).toBe(true);
      expect(fieldOf(body, "degradedReason")).toBe("历史里找不到该块");
    });
  });
});
