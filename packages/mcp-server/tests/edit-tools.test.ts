// 这层管：三个「改动」工具走 in-memory transport 的行为——
// 落盘是否真经过 core 的写管线（AC-2）、失败是否折成保留 `HrError.code` 的工具结果（AC-3）。

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  leaveWorkspace,
  payloadOf,
  sessionOf,
  textOf,
  workspaceIn,
} from "./harness";

let workspace = "";

const docIn = async (name: string): Promise<string> => {
  const path = join(workspace, name);
  await writeFile(path, ANNOTATED_DOC, "utf8");
  return path;
};

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-edit-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

describe("hr_patch_node", () => {
  it("should go through patchFile: changed plus an undo snapshot", async () => {
    const path = await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_patch_node",
      arguments: {
        filePath: "doc.html",
        nodeId: "p-1",
        action: "replace",
        htmlContent: "<p>新正文</p>",
      },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(false);
    const payload = payloadOf(result);
    expect(payload["changed"]).toBe(true);
    expect(payload["historyPath"]).not.toBeNull();
    expect(await readFile(path, "utf8")).toContain("新正文");
  });

  it("should surface an unknown target as a tool error", async () => {
    await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_patch_node",
      arguments: {
        filePath: "doc.html",
        nodeId: "nope",
        action: "replace",
        htmlContent: "<p>x</p>",
      },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).not.toBe("");
  });
});

describe("hr_patch_node · delete", () => {
  it("should drop the node and leave the rest of the document alone", async () => {
    const path = await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_patch_node",
      arguments: { filePath: "doc.html", nodeId: "p-1", action: "delete", htmlContent: "" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(false);
    const written = await readFile(path, "utf8");
    expect(written).not.toContain("正文");
    expect(written).toContain('data-hr-id="h1"');
  });
});

describe("hr_patch_node · 入参", () => {
  it("should let the schema reject an action outside the five core verbs", async () => {
    await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_patch_node",
      arguments: {
        filePath: "doc.html",
        nodeId: "p-1",
        action: "rewrite",
        htmlContent: "<p>x</p>",
      },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    expect(textOf(result)).toContain("action");
  });
});

describe("hr_apply_style", () => {
  it("should swap the theme stylesheet for a builtin visualId", async () => {
    const path = await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_apply_style",
      arguments: { filePath: "doc.html", visualId: "executive-brief" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(false);
    expect(await readFile(path, "utf8")).toContain('id="hr-theme"');
  });

  it("should return the tone spec without touching the file", async () => {
    const path = await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_apply_style",
      arguments: { filePath: "doc.html", toneId: "feynman-tech" },
    });
    await session.close();

    const payload = payloadOf(result);
    expect(typeof payload["tone"]).toBe("string");
    expect(payload["visual"]).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(ANNOTATED_DOC);
  });
});

describe("hr_apply_style · 失败路径", () => {
  it("should reject a call that gives neither visualId nor toneId", async () => {
    await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_apply_style",
      arguments: { filePath: "doc.html" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("invalid_input");
  });

  it("should turn an unknown toneId into a tool error", async () => {
    await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_apply_style",
      arguments: { filePath: "doc.html", toneId: "no-such-tone" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).not.toBe("");
  });
});

describe("hr_resolve_annotation", () => {
  it("should mark the pending annotation resolved through the patch pipeline", async () => {
    const path = await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_resolve_annotation",
      arguments: { filePath: "doc.html", annotationId: "ann-01", resolutionNote: "补了新数据" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(false);
    const written = await readFile(path, "utf8");
    expect(written).toContain('"status":"resolved"');
    expect(written).toContain("补了新数据");
  });

  it("should turn an unknown annotationId into a tool error", async () => {
    await docIn("doc.html");
    const session = await sessionOf();
    const result = await session.client.callTool({
      name: "hr_resolve_annotation",
      arguments: { filePath: "doc.html", annotationId: "ann-nope" },
    });
    await session.close();

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).not.toBe("");
  });
});
