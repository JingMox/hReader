// 这层管：三个「读 / 开篇」工具走 in-memory transport 的行为——
// 入参 schema、调的是哪条 core 原语、失败是否折成保留 `HrError.code` 的工具结果（AC-2 / AC-3）。

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDocWith } from "../src/tools/createDoc";
import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  isRecord,
  leaveWorkspace,
  payloadOf,
  sessionOf,
  textOf,
  uiUriOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-read-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

describe("hr_create_doc", () => {
  it("should write a valid document and point the ui meta at it", async () => {
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_create_doc",
      arguments: { filePath: "draft.html", title: "新稿" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(false);
    expect(await readFile(join(workspace, "draft.html"), "utf8")).toContain("<h1>新稿</h1>");
    expect(uiUriOf(result)).toMatch(/^ui:\/\/hreader\/view\//u);
  });

  it("should refuse a template that fails validateDocument", async () => {
    const brokenTemplate = createDocWith(() => "<article></article>");
    const result = await brokenTemplate({ filePath: "broken.html", title: "坏模板" });

    expect(result.isError).toBe(true);
    expect(codeOf(result)).toBe("invalid_document");
    await expect(readFile(join(workspace, "broken.html"), "utf8")).rejects.toThrow();
  });

  it("should refuse to overwrite an existing file", async () => {
    await writeFile(join(workspace, "taken.html"), "<article></article>", "utf8");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_create_doc",
      arguments: { filePath: "taken.html", title: "撞名" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("io_failure");
  });
});

describe("hr_outline", () => {
  it("should list the structure and the pending annotations", async () => {
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_outline",
      arguments: { filePath: "doc.html" },
    });
    await session.close();

    const payload = payloadOf(result);
    expect(Array.isArray(payload["nodes"]) && payload["nodes"].length > 0).toBe(true);
    const pending = payload["pendingAnnotations"];
    expect(Array.isArray(pending) && isRecord(pending[0]) && pending[0]["id"] === "ann-01").toBe(
      true,
    );
    expect(typeof payload["wordCount"]).toBe("number");
  });

  it("should reject an absolute path outside the workspace", async () => {
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_outline",
      arguments: { filePath: "/etc/hosts" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("path_outside_workspace");
  });
});

describe("hr_read_node", () => {
  it("should return the node html for an id from the outline", async () => {
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_read_node",
      arguments: { filePath: "doc.html", nodeId: "p-1" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(false);
    expect(textOf(result)).toContain("正文");
  });

  it("should turn an unknown nodeId into a tool error that keeps the code", async () => {
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_read_node",
      arguments: { filePath: "doc.html", nodeId: "nope" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).not.toBe("");
    expect(textOf(result)).not.toContain(" at ");
  });
});
