// P1-4：`/diff` 必须给**这条批注所在块**的 diff，而不是全篇。
// 全篇 diff 有两个可观察后果：两条不同块的批注拿到同一份结果；面板也没有 `nodeId` 可标块。
// 另加一条短文档守门：`degraded` 不该在这种规模上为真（审计实测 2 000 字符 → false）。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { TextChunk } from "../../src/annotations";
import { cookieOf, httpCall, jsonBodyOf, withServer, type TestServer } from "./harness";
import { withPost } from "./wire";

const fieldOf = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;

const isChunk = (value: unknown): value is TextChunk => {
  const kind = fieldOf(value, "kind");
  return (
    typeof fieldOf(value, "text") === "string" &&
    (kind === "ins" || kind === "del" || kind === "same")
  );
};

const chunksOf = (body: unknown): readonly TextChunk[] => {
  const raw = fieldOf(body, "chunks");
  if (!Array.isArray(raw) || !raw.every(isChunk)) throw new Error("chunks 形状不符");
  return raw;
};

const textOf = (body: unknown): string =>
  chunksOf(body)
    .map((chunk) => chunk.text)
    .join("");

const addAt = async (ctx: TestServer, nodeId: string, exact: string): Promise<string> => {
  const response = await httpCall(ctx.port, {
    method: "POST",
    path: `/api/doc/${ctx.docId}/annotations`,
    headers: withPost(ctx.token),
    body: JSON.stringify({
      docId: ctx.docId,
      nodeId,
      anchor: { exact, prefix: "", suffix: "", start: 0 },
      note: "批注",
    }),
  });
  expect(response.status).toBe(201);
  const id = fieldOf(jsonBodyOf(response), "id");
  if (typeof id !== "string") throw new Error("响应缺 id");
  return id;
};

const patchBlock = async (ctx: TestServer, targetId: string, fragment: string): Promise<void> => {
  const response = await httpCall(ctx.port, {
    method: "POST",
    path: "/api/patch",
    headers: withPost(ctx.token),
    body: JSON.stringify({ docId: ctx.docId, action: "replace", targetId, fragment }),
  });
  expect(response.status).toBe(200);
};

const deleteBlock = async (ctx: TestServer, targetId: string): Promise<void> => {
  const response = await httpCall(ctx.port, {
    method: "POST",
    path: "/api/patch",
    headers: withPost(ctx.token),
    body: JSON.stringify({ docId: ctx.docId, action: "delete", targetId }),
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

/** 当前文档里那块的真实 id：patch 会重算块 ID，旧 id 在正文里通常已经不在了（D.4）。 */
const currentNodeIdOf = (ctx: TestServer, text: string): string => {
  const html = readFileSync(ctx.file, "utf8");
  const match = new RegExp(`data-hr-id="([^"]+)"[^>]*>${text}<`).exec(html);
  if (match?.[1] === undefined) throw new Error(`当前文档里找不到块：${text}`);
  return match[1];
};

/** 两条不同块的批注 + 两块都被改过：全篇 diff 会让它们拿到同一份结果。 */
const twoBlockDiffs = async (
  ctx: TestServer,
): Promise<{
  readonly left: unknown;
  readonly right: unknown;
  readonly leftNodeId: string;
  readonly rightNodeId: string;
}> => {
  const leftId = await addAt(ctx, "hr-c", "正文一");
  const rightId = await addAt(ctx, "hr-d", "正文二");
  await patchBlock(ctx, "hr-c", '<p data-hr-id="hr-c">左块新说</p>');
  await patchBlock(ctx, "hr-d", '<p data-hr-id="hr-d">右块新说</p>');
  return {
    left: await diffOf(ctx, leftId),
    right: await diffOf(ctx, rightId),
    leftNodeId: currentNodeIdOf(ctx, "左块新说"),
    rightNodeId: currentNodeIdOf(ctx, "右块新说"),
  };
};

/** 删掉被批注的块：`hr-d` 真没了（`hr-c` 还在，位置重识别不该把它当成 `hr-d`）。 */
const diffOfDeletedBlock = async (ctx: TestServer): Promise<unknown> => {
  const anId = await addAt(ctx, "hr-d", "正文二");
  await deleteBlock(ctx, "hr-d");
  return diffOf(ctx, anId);
};

/** 判定“按位置重识别到同一块”：`reason` 必须精确，`after` 必须是**那块**的新文本。
 *  D.4 裁定：重识别时 `nodeId` = **新** id（前端用它标块），`originNodeId` = 批注记录的旧 id。 */
const expectReidentified = (
  body: unknown,
  after: string,
  newNodeId: string,
  oldNodeId: string,
): void => {
  expect(fieldOf(body, "reason")).toBe("block_reidentified");
  expect(fieldOf(body, "after")).toBe(after);
  expect(fieldOf(body, "degraded")).toBe(true);
  expect(fieldOf(body, "nodeId")).toBe(newNodeId);
  expect(fieldOf(body, "originNodeId")).toBe(oldNodeId);
};

/** 两条结果必须各自只含自己那块的新文本，且都声明“ID 重建”。 */
const expectOwnBlockOnly = (
  left: unknown,
  right: unknown,
  ids: { readonly leftNodeId: string; readonly rightNodeId: string },
): void => {
  // 旧 id 在 patch 后已经不在正文里了；响应必须给“现在能标到的那一块”的 id，另带旧 id 供排查。
  expect(fieldOf(left, "nodeId")).toBe(ids.leftNodeId);
  expect(fieldOf(right, "nodeId")).toBe(ids.rightNodeId);
  expect(ids.leftNodeId).not.toBe("hr-c");
  expect(ids.rightNodeId).not.toBe("hr-d");
  expect(fieldOf(left, "originNodeId")).toBe("hr-c");
  expect(fieldOf(right, "originNodeId")).toBe("hr-d");
  expect(textOf(left)).toContain("左块新说");
  expect(textOf(left)).not.toContain("右块新说");
  expect(textOf(right)).toContain("右块新说");
  expect(textOf(right)).not.toContain("左块新说");
  expect(textOf(left)).not.toBe(textOf(right));
  // patch 重建了块 ID：按位置重识别，口语上“内容变了”，所以必须声明降级（裁定：三档语义）。
  expect(fieldOf(left, "degraded")).toBe(true);
  expect(fieldOf(left, "reason")).toBe("block_reidentified");
};

describe("GET …/diff · 粒度是块（P1-4）", () => {
  it("should diff only the annotation's own block", async () => {
    await withServer(async (ctx) => {
      const { left, right, leftNodeId, rightNodeId } = await twoBlockDiffs(ctx);

      expectOwnBlockOnly(left, right, { leftNodeId, rightNodeId });
    });
  });

  it("should keep degraded false when the annotated block itself is untouched", async () => {
    await withServer(async (ctx) => {
      const anId = await addAt(ctx, "hr-c", "正文一");
      // 只改另一块：批注块在快照与当前文档里都能按 ID 命中 ⇒ 不需要声明降级。
      await patchBlock(ctx, "hr-d", '<p data-hr-id="hr-d">右块新说</p>');

      const body = await diffOf(ctx, anId);

      expect(fieldOf(body, "nodeId")).toBe("hr-c");
      expect(fieldOf(body, "after")).toBe("正文一");
      expect(fieldOf(body, "degraded")).toBe(false);
      expect(fieldOf(body, "reason")).toBeUndefined();
      // 命中时新旧 id 相同，没必要多给一个字段（D.4：命中 → 无 `originNodeId`）。
      expect(fieldOf(body, "originNodeId")).toBeUndefined();
    });
  });
});

// 三档里的后两档（重识别 / 缺失）单独一个 `describe`：它们是 D.4 新补的字段语义，
// 和“全篇 diff 变成块级 diff”是两件事，混在一个块里会超 `max-lines-per-function`。
describe("GET …/diff · 块 ID 重建后的三档语义（D.4）", () => {
  // “同位置”必须是**文档先序**，且 `flattenOf` 不能动模型本身：用 `reverse()` 而非 `toReversed()` 时
  // 子数组会被就地反转，同一模型第二次 flatten（`blockOf` 一次 + `findIndex` 一次）返回的顺序就和第一次不同，
  // 位置索引落到邻块 `hr-d`（同 tag、不同文本）→ `before` 取到别人的历史。所以这里必须连 `before` 一起断言。
  //
  // 变异体表（M1 一族）：
  //   M1a `children.reverse()`（就地）      → KILLED（模型 children 被冻结，服务端 500）
  //   M1b `[...children].reverse()`（非就地）→ **等价变异体，不可杀**：与 `toReversed()` 同语义。
  //       若将来 `flattenOf` 改成复用可变数组（或用 `splice`/`sort` 原地操作），M1b 会变成可杀，
  //       届时把它升级为必杀（这条注释就是那天的线索）。
  //   M1c index 翻转（反文档序）             → KILLED（本用例 + `should diff only the annotation's own block`）
  it("should reidentify by document-order position, not by a mutated order", async () => {
    await withServer(async (ctx) => {
      const anId = await addAt(ctx, "hr-c", "正文一");
      await patchBlock(ctx, "hr-c", '<p data-hr-id="hr-c2">左块新说</p>');
      // 新 id 由 `injectNodeIds` 按内容重算（片段自带的 id 会被剥掉），所以从正文里取而不是写死。
      const newNodeId = currentNodeIdOf(ctx, "左块新说");

      const body = await diffOf(ctx, anId);

      expect(fieldOf(body, "before")).toBe("正文一");
      expect(newNodeId).not.toBe("hr-c");
      expectReidentified(body, "左块新说", newNodeId, "hr-c");
    });
  });

  it("should report block_missing when the annotated block is gone", async () => {
    await withServer(async (ctx) => {
      const body = await diffOfDeletedBlock(ctx);

      expect(fieldOf(body, "after")).toBe("");
      expect(fieldOf(body, "degraded")).toBe(true);
      expect(fieldOf(body, "reason")).toBe("block_missing");
      expect(typeof fieldOf(body, "degradedReason")).toBe("string");
      // 没有替身可给：`nodeId` 只能回旧 id，`originNodeId` 同值（D.4）。
      expect(fieldOf(body, "nodeId")).toBe("hr-d");
      expect(fieldOf(body, "originNodeId")).toBe("hr-d");
    });
  });
});
