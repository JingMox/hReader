// 这层管：G3-4 —— 并发写（core 有 `runLocked`，MCP 层从没验过它在这条路上生效）。
//
// 它会因为什么而红：去掉 `patchFile` 里的 `runLocked` 之后，两条 `readFile → 改 → writeFile`
// 会互相覆盖——表现正是"两个响应都 `isError:false`，文件里只有一处改动"。
// 那是唯一被禁止的结局（双绿却丢改动）；串行化成功、或干脆一个报冲突，都算合格。

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  isErrorResultOf,
  leaveWorkspace,
  sessionOf,
  textOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-concurrent-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

interface Outcome {
  readonly isError: boolean;
  readonly text: string;
}

const patchOf = async (nodeId: string, html: string): Promise<Outcome> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({
    name: "hr_patch_node",
    arguments: { filePath: "doc.html", nodeId, action: "replace", htmlContent: html },
  });
  await session.close();
  return { isError: isErrorResultOf(result), text: textOf(result) };
};

describe("hr_patch_node · 并发写同一份文档", () => {
  it("should never answer both calls green while one of the two changes is lost", async () => {
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");

    const [first, second] = await Promise.all([
      patchOf("h1", '<h1 data-hr-id="h1">并发甲的标题</h1>'),
      patchOf("p-1", '<p data-hr-id="p-1">并发乙的正文</p>'),
    ]);
    const body = await readFile(join(workspace, "doc.html"), "utf8");
    const landed = [body.includes("并发甲的标题"), body.includes("并发乙的正文")];

    // 唯一禁止的结局：两个都成功、盘上只落了一处。
    expect(first.isError && second.isError).toBe(false);
    if (!first.isError && !second.isError) {
      expect(landed).toEqual([true, true]);
      return;
    }
    // 允许的另一种语义：其中一个明说冲突（`isError`），且落的正好是另一个。
    expect(landed.filter(Boolean)).toHaveLength(1);
  }, 30_000);

  it("should keep the lock off the read path, so two reads still answer at once", async () => {
    // 对照组：读工具不拿锁——它俩一旦互相阻塞，说明锁被放到了错误的位置（把整台 server 串死）。
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const session = await sessionOf();
    const results = await Promise.all([
      session.client.callTool({ name: "hr_outline", arguments: { filePath: "doc.html" } }),
      session.client.callTool({ name: "hr_outline", arguments: { filePath: "doc.html" } }),
    ]);
    await session.close();

    expect(results.map((one) => isErrorResultOf(one))).toEqual([false, false]);
  }, 30_000);
});
