// This layer: `hr_patch_node`'s success response must also carry `_meta.ui.resourceUri`.
// Existing cases only assert ui meta for `hr_create_doc` (`read-tools.test.ts`): the most important arm — editing — went unwatched;
// delete the ui option from okResult in `src/tools/patch-node.ts` and the whole suite stays green.
//
// What makes it red: patch succeeds but `_meta.ui` vanishes / the URI prefix changes / the view it points to is unreadable or serves pre-edit content.

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

describe("hr_patch_node's reading-view metadata", () => {
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

    // The URI it points at must really be readable, and must serve the **post-edit** body.
    const read = await session.client.readResource({ uri: uiUriOf(patched) });
    await session.close();

    const first = read.contents[0];
    expect(first !== undefined && "text" in first ? first.text : "").toContain("改过的标题");
  }, 30_000);
});
