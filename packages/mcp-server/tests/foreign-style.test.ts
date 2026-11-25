// 这层管：MCP 写工具与 HTTP 同口径——外来文档可用 `hr_apply_style` 换主题，
// 且样式快照照常被 `hr_undo` 逐字节退回；内容 patch 仍拒绝且不写盘。

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codeOf,
  isErrorResultOf,
  leaveWorkspace,
  sessionOf,
  workspaceIn,
} from "./harness";

const FOREIGN_DOC =
  '<!doctype html><html><body><div class="app"><script>1</script>外来内容</div></body></html>';

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-foreign-style-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

describe("hr_apply_style · 外来文档", () => {
  it("should apply a theme to a foreign doc and undo it back to the original bytes", async () => {
    const path = join(workspace, "foreign.html");
    await writeFile(path, FOREIGN_DOC, "utf8");
    const session = await sessionOf();
    const styled = await session.client.callTool({
      name: "hr_apply_style",
      arguments: { filePath: "foreign.html", visualId: "atelier-editorial" },
    });

    expect(isErrorResultOf(styled)).toBe(false);
    expect(await readFile(path, "utf8")).toContain('id="hr-theme"');

    const undone = await session.client.callTool({
      name: "hr_undo",
      arguments: { filePath: "foreign.html" },
    });
    await session.close();

    expect(isErrorResultOf(undone)).toBe(false);
    expect(await readFile(path, "utf8")).toBe(FOREIGN_DOC);
  });

  it("should still refuse hr_patch_node on a foreign doc without writing", async () => {
    const path = join(workspace, "foreign.html");
    await writeFile(path, FOREIGN_DOC, "utf8");
    const session = await sessionOf();
    const patched = await session.client.callTool({
      name: "hr_patch_node",
      arguments: {
        filePath: "foreign.html",
        nodeId: "hr-x",
        action: "append",
        htmlContent: "<b>x</b>",
      },
    });
    await session.close();

    expect(isErrorResultOf(patched)).toBe(true);
    expect(codeOf(patched)).not.toBe("");
    expect(await readFile(path, "utf8")).toBe(FOREIGN_DOC);
  });
});
