// 这层管：三个「读 / 开篇」工具走 in-memory transport 的行为——
// 入参 schema、调的是哪条 core 原语、失败是否折成保留 `HrError.code` 的工具结果（AC-2 / AC-3）。

import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDocWith } from "../src/tools/create-doc";
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

const createOf = async (args: { filePath: string; title: string }): Promise<unknown> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({
    name: "hr_create_doc",
    arguments: args,
  });
  await session.close();
  return result;
};

describe("hr_create_doc", () => {
  it("should write a valid document and point the ui meta at it", async () => {
    const result = await createOf({ filePath: "draft.html", title: "新稿" });

    expect(isErrorResultOf(result)).toBe(false);
    expect(await readFile(join(workspace, "draft.html"), "utf8")).toMatch(
      /<h1 data-hr-id="hr-[0-9a-f]+">新稿<\/h1>/u,
    );
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
    const result = await createOf({ filePath: "taken.html", title: "撞名" });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("io_failure");
  });

  it("should create nested directories that are inside the workspace", async () => {
    const result = await createOf({ filePath: "a/b/c.html", title: "深处" });

    expect(isErrorResultOf(result)).toBe(false);
    expect(await readFile(join(workspace, "a", "b", "c.html"), "utf8")).toContain("深处");
  });
});

// AC-1 → AC-3：建完就能改。这一组用例的职责是"以后谁再手搓文档骨架，它会红"——
// 新建文档的 id 必须由 core 的注入器给，否则大纲为空、`hr_patch_node` 只剩 `root` 一个靶子。
const outlineOf = async (filePath: string): Promise<Record<string, unknown>> => {
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({
    name: "hr_outline",
    arguments: { filePath },
  });
  await session.close();
  return payloadOf(result);
};

const outlineNodesOf = async (filePath: string): Promise<readonly Record<string, unknown>[]> => {
  const nodes = (await outlineOf(filePath))["nodes"];
  return Array.isArray(nodes) ? nodes.filter(isRecord) : [];
};

const headingIdOf = (nodes: readonly Record<string, unknown>[]): unknown =>
  nodes.find((node) => node["tag"] === "h1")?.["id"];

describe("hr_create_doc · 建完就能改", () => {
  it("should hand out node ids, so that a new document actually has an outline", async () => {
    expect(isErrorResultOf(await createOf({ filePath: "doc.html", title: "可改" }))).toBe(false);

    const payload = await outlineOf("doc.html");
    const diagnostics = payload["diagnostics"];
    const withoutId = Array.isArray(diagnostics)
      ? diagnostics.filter(
          (entry) => isRecord(entry) && entry["code"] === "outline_node_without_id",
        )
      : [];

    expect(Array.isArray(payload["nodes"]) && payload["nodes"].length > 0).toBe(true);
    expect(withoutId).toEqual([]);
  });

  it("should let hr_patch_node replace the h1 that hr_outline just reported", async () => {
    await createOf({ filePath: "doc.html", title: "原标题" });
    const nodeId = headingIdOf(await outlineNodesOf("doc.html"));
    expect(typeof nodeId).toBe("string");

    const session = await sessionOf();
    const patched: unknown = await session.client.callTool({
      name: "hr_patch_node",
      arguments: {
        filePath: "doc.html",
        nodeId,
        action: "replace",
        htmlContent: "<h1>改过了</h1>",
      },
    });
    await session.close();

    expect(isErrorResultOf(patched)).toBe(false);
    expect(await readFile(join(workspace, "doc.html"), "utf8")).toContain("改过了");
  });
});

// P1-1：`filePath` 来自模型输出（可被文档内容里的注入操纵），越界必须在建目录之前拒掉。
describe("hr_create_doc · 工作区边界", () => {
  it("should reject a path that escapes the workspace before creating anything", async () => {
    const outside = join(dirname(workspace), `${basename(workspace)}-escape.html`);
    const result = await createOf({
      filePath: `../${basename(workspace)}-escape.html`,
      title: "越界",
    });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("path_outside_workspace");
    await expect(readFile(outside, "utf8")).rejects.toThrow();
  });

  it("should reject a symlink that points out of the workspace", async () => {
    const outside = await workspaceIn("hreader-mcp-outside-");
    await symlink(outside, join(workspace, "link"), "dir");
    const result = await createOf({ filePath: "link/x.html", title: "链外" });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("path_outside_workspace");
    expect(await readdir(outside)).toEqual([]);
    await leaveWorkspace(outside);
  });
});

// 回显：都是"用户到底发了什么"的问题，和越界判定分开看。
describe("hr_create_doc · 回显", () => {
  it("should echo an absolute path verbatim instead of a `..`-laden relative one", async () => {
    const result = await createOf({ filePath: "/etc/passwd", title: "越界" });
    const text = textOf(result);

    // 用户发来的是 `/etc/passwd`：回显必须是它，不能是 `../../../../etc/passwd`（F8-2）。
    expect(codeOf(result)).toBe("path_outside_workspace");
    expect(text).toContain("/etc/passwd");
    expect(text).not.toContain("..");
    // 界内绝对路径走"能落盘"那一侧：按落盘位置判越界，不因前导 `/` 先拒。
    const inside = join(workspace, "abs.html");
    const created = await createOf({ filePath: inside, title: "界内绝对" });
    expect(isErrorResultOf(created)).toBe(false);
    expect(await readFile(inside, "utf8")).toContain("界内绝对");
  });
  it("should turn a path under an existing file into an io failure", async () => {
    await writeFile(join(workspace, "taken.html"), "<article></article>", "utf8");
    const result = await createOf({ filePath: "taken.html/x.html", title: "穿文件" });
    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("io_failure");
  });

  it("should not treat an unparsable path as if it were inside the workspace", async () => {
    const result = await createOf({ filePath: "a\u0000b.html", title: "非法" });
    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("internal");
  });
});

// 边界判定的边角：`..foo` 是被误拒的合法目录；自身与父目录是 `relative()` 返回空串 / `..` 的两头。
describe("hr_create_doc · 路径判定的边角", () => {
  it("should accept a directory whose name merely starts with two dots", async () => {
    const result = await createOf({ filePath: "..foo/x.html", title: "点点" });

    expect(isErrorResultOf(result)).toBe(false);
    expect(await readFile(join(workspace, "..foo", "x.html"), "utf8")).toContain("点点");
  });

  it("should reject the workspace itself as a target", async () => {
    const result = await createOf({ filePath: ".", title: "根" });

    expect(isErrorResultOf(result)).toBe(true);
    expect(codeOf(result)).toBe("path_outside_workspace");
  });

  it("should reject the parent directory itself, with or without a trailing slash", async () => {
    for (const filePath of ["..", "../"]) {
      const result = await createOf({ filePath, title: "父级" });

      expect(isErrorResultOf(result)).toBe(true);
      expect(codeOf(result)).toBe("path_outside_workspace");
    }
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
