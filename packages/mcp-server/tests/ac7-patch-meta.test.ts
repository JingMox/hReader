// 这层管：AC-7 的另一半 —— `hr_patch_node` 的成功响应也要带 `_meta.ui.resourceUri`。
// 现有用例只对 `hr_create_doc` 断言了 ui meta（`read-tools.test.ts`）：改稿这条最重要的一臂没人盯，
// 把 `src/tools/patch-node.ts` 里 okResult 的 ui 选项删掉，全套测试照样绿。
//
// 它会因为什么而红：patch 成功但 `_meta.ui` 消失 / URI 前缀换了 / 指向的视图读不出来或读到改前正文。

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  isErrorResultOf,
  leaveWorkspace,
  sessionOf,
  uiUriOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-patch-meta-");
  process.chdir(workspace);
  await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

describe("hr_patch_node 的阅读视图元数据（AC-7）", () => {
  it("should point the patched result at a readable view of the same document", async () => {
    const session = await sessionOf();
    const patched: unknown = await session.client.callTool({
      name: "hr_patch_node",
      arguments: {
        filePath: "doc.html",
        nodeId: "h1",
        action: "replace",
        htmlContent: "<h1>改过的标题</h1>",
      },
    });
    expect(isErrorResultOf(patched)).toBe(false);
    expect(uiUriOf(patched)).toMatch(/^ui:\/\/hreader\/view\//u);

    // 指过去的 URI 必须真的读得出来，且读到的是**改后**的正文。
    const read = await session.client.readResource({ uri: uiUriOf(patched) });
    await session.close();

    const first = read.contents[0];
    expect(first !== undefined && "text" in first ? first.text : "").toContain("改过的标题");
  }, 30_000);
});
