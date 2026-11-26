// 这层管：`hr_create_doc` 的 `kind`（按文档形态起稿）与 `hr_patch_node` 回执里的排版警告——
// 两者都只是把 core 的能力透出来，这里钉的是“透出来了、形状没变”。

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isErrorResultOf, leaveWorkspace, payloadOf, sessionOf, workspaceIn } from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-kind-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

const callOf = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({ name, arguments: args });
  await session.close();
  return result;
};

describe("hr_create_doc · kind", () => {
  it("should write the skeleton of the requested kind and echo the kind back", async () => {
    const result = await callOf("hr_create_doc", {
      filePath: "weekly.html",
      title: "产品周会",
      kind: "minutes",
    });
    const html = await readFile(join(workspace, "weekly.html"), "utf8");

    expect(isErrorResultOf(result)).toBe(false);
    expect(payloadOf(result)).toEqual({ path: "weekly.html", title: "产品周会", kind: "minutes" });
    expect(html).toContain('<article data-hr-id="root" data-hr-kind="minutes">');
    expect(html).toContain('data-hr-component="step-timeline"');
  });

  it("should keep the minimal document and the old payload shape when kind is omitted", async () => {
    const result = await callOf("hr_create_doc", { filePath: "plain.html", title: "空稿" });
    const html = await readFile(join(workspace, "plain.html"), "utf8");

    expect(payloadOf(result)).toEqual({ path: "plain.html", title: "空稿" });
    expect(html).not.toContain("data-hr-kind");
  });
});

describe("hr_patch_node · 排版警告", () => {
  it("should return layout problems of the fragment as warnings and still write it", async () => {
    await callOf("hr_create_doc", { filePath: "doc.html", title: "稿", kind: "note" });
    const result = await callOf("hr_patch_node", {
      filePath: "doc.html",
      nodeId: "root",
      action: "append",
      htmlContent: '<p style="color:red">红字</p>',
    });
    const warnings = payloadOf(result)["warnings"];

    expect(isErrorResultOf(result)).toBe(false);
    expect(JSON.stringify(warnings)).toContain('"code":"inline_style"');
    expect(await readFile(join(workspace, "doc.html"), "utf8")).toContain("红字");
  });
});
