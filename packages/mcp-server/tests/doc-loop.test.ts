// 这层管：唯一一条"用户能感知"的主链，且跑在**交付物**上（`dist/main.js` 真子进程）：
// 建稿 → 大纲 → 拿大纲给的 id 改正文 → 再大纲（新 id 可寻址）→ undo → 字节回到建稿那一刻。
//
// 它会因为什么而红（逐环）：
// - 建稿不再注入 id → 第 2 步 `nodes` 为空或 `outline_node_without_id` 非空；
// - 改完正文没有重算 id（id 漂移被改成"保留旧 id"或"丢 id"）→ 第 3 步大纲里找不到可寻址的 h1；
// - 写盘留下半截/多拼 BOM → 末环字节比不回去（这条比 "内容包含某词" 硬：少一个换行也红）；
// - 快照不是"写前字节"或 undo 不消费快照 → 末环字节不等，且再 undo 一次要报 `undo_unavailable`。
//
// 注意：id 会漂移是既有设计（工具描述已写明"不要缓存 id"），所以这里断言的是
// "新 id 可寻址"，**不是** "id 不变"。

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { nodePatchDeps, undoPatch } from "@hreader/core";

import { isRecord, workspaceIn, leaveWorkspace } from "./harness";
import {
  INITIALIZE,
  INITIALIZED,
  binPathOf,
  buildDist,
  byIdOf,
  linesOf,
  probeOf,
  resultOf,
  textOf,
} from "./probe";

beforeAll(buildDist, 180_000);

const outlineOf = (text: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) ? parsed : {};
};

const nodesOf = (outline: Record<string, unknown>): readonly Record<string, unknown>[] => {
  const nodes = outline["nodes"];
  return Array.isArray(nodes) ? nodes.filter(isRecord) : [];
};

const headingIdOf = (nodes: readonly Record<string, unknown>[]): unknown =>
  nodes.find((node) => node["tag"] === "h1")?.["id"];

const diagnosticsOf = (outline: Record<string, unknown>): readonly unknown[] => {
  const diagnostics = outline["diagnostics"];
  return Array.isArray(diagnostics) ? diagnostics : [];
};

const callIn = async (
  workspace: string,
  lines: readonly string[],
  expected: number,
): Promise<Map<unknown, Record<string, unknown>>> => {
  const { frames } = await probeOf(await binPathOf(), { lines, expected, cwd: workspace });
  return byIdOf(frames);
};

interface Step {
  readonly workspace: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** 每步一个进程：SDK 会并发执行同一条管道里收到的 `tools/call`，"先建后读"必须分两次握手。 */
const resultIn = async ({ workspace, tool, args }: Step): Promise<string> => {
  const frames = await callIn(
    workspace,
    linesOf([
      INITIALIZE,
      INITIALIZED,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
    ]),
    1,
  );
  const frame = frames.get(2);
  expect(resultOf(frame)["isError"]).toBeUndefined();
  return textOf(frame);
};

/** 建稿 → 第一次大纲：返回建稿时的字节与大纲里的标题 id（`expect` 都在这里，`it` 只读结果）。 */
const createAndOutlineOf = async (
  workspace: string,
): Promise<{ createdBytes: Buffer; oldId: unknown }> => {
  await resultIn({
    workspace,
    tool: "hr_create_doc",
    args: { filePath: "loop.html", title: "闭环" },
  });
  const outlineResult = await resultIn({
    workspace,
    tool: "hr_outline",
    args: { filePath: "loop.html" },
  });
  const outline = outlineOf(outlineResult);
  const nodes = nodesOf(outline);
  expect(nodes.length).toBeGreaterThan(0);
  expect(diagnosticsOf(outline)).toEqual([]);
  const oldId = headingIdOf(nodes);
  expect(typeof oldId).toBe("string");
  return { createdBytes: await readFile(join(workspace, "loop.html")), oldId };
};

/** 用大纲给的 id 改正文，再大纲 + 读节点：id 必须**仍是那一个**且真的可寻址。
 *  `replace` 的新根继承目标自己的 id，所以改完正文标题的锚点不变。 */
const patchAndReadBackOf = async (workspace: string, oldId: unknown): Promise<void> => {
  await resultIn({
    workspace,
    tool: "hr_patch_node",
    args: {
      filePath: "loop.html",
      nodeId: oldId,
      action: "replace",
      htmlContent: "<h1>改过的标题</h1>",
    },
  });
  const again = await resultIn({
    workspace,
    tool: "hr_outline",
    args: { filePath: "loop.html" },
  });
  const newId = headingIdOf(nodesOf(outlineOf(again)));
  expect(typeof newId).toBe("string");
  // id 归产品所有：改内容不换锚点，大纲继续用同一个 id 指这块。
  expect(newId).toBe(oldId);

  const readBack = await resultIn({
    workspace,
    tool: "hr_read_node",
    args: { filePath: "loop.html", nodeId: newId },
  });
  const node = outlineOf(readBack);
  expect(node["html"]).toBe(`<h1 data-hr-id="${String(newId)}">改过的标题</h1>`);
  expect(node["truncated"]).toBe(false);
};

/**
 * undo：快照是"写前字节"，所以退回到建稿那一刻。
 * 这个 E2E 覆盖两条关系：**MCP stdio 工具面 ↔ core 进程内原语**的字节对齐，以及**构建产物真能启动**
 * （`probe.ts` 用 `buildDist` 真跑 `pnpm build`、再用 `spawn(process.execPath, [entry])` 起子进程走 stdio 握手）。
 * 撤销这一步**刻意**在进程内用 `undoPatch` 而不是工具：本文件的读改侧已经把返回值和旧 id 逐字比对过了，
 * 撤销要的正是 CLI 侧同款的 `UndoResult`（`restoredFrom`/字节数），走工具面就只能拿到映射后的文本。
 * MCP 侧对外入口是 `hr_undo`（`src/tools/undo.ts`，经 `revertLast`）；两者语义相同，错误码不同：
 * `undo_unavailable` 是 core 层码，工具面把它翻成 `nothing_to_undo`——所以下面断言里的
 * `undo_unavailable` 是本函数**刻意**留在 core 层的结果，不是工具面的行为。
 */
const undoBackOf = async (workspace: string, createdBytes: Buffer): Promise<void> => {
  const restored = await undoPatch({ workspace, file: "loop.html" }, nodePatchDeps);
  expect(restored.restoredFrom).toContain(join(".hreader", "history"));
  expect((await readFile(join(workspace, "loop.html"))).equals(createdBytes)).toBe(true);
  // 快照被消费掉了：再撤一次必须明说"没有可回滚的历史"，而不是静默"成功"。
  await expect(undoPatch({ workspace, file: "loop.html" }, nodePatchDeps)).rejects.toMatchObject({
    code: "undo_unavailable",
  });
};

describe("dist/main.js · 主链闭环", () => {
  it("should take a created doc through outline, patch, outline again, then undo back to the exact bytes", async () => {
    const workspace = await workspaceIn("hreader-mcp-loop-");
    try {
      const { createdBytes, oldId } = await createAndOutlineOf(workspace);
      await patchAndReadBackOf(workspace, oldId);
      await undoBackOf(workspace, createdBytes);
    } finally {
      await leaveWorkspace(workspace);
    }
  }, 60_000);
});
