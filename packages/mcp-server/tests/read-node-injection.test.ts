// 这层管：`hr_read_node` 的目标解析口径与 CLI `hr read` 对齐。
// 旧实现把 nodeId 原样插进 `[data-hr-id="${nodeId}"]`：选择器文法对 `"]`/`[` 判非法，
// 注入只能造出 `invalid_selector`（造不出第二个选择器），但它把"输入是选择器还是 id"
// 这第二层语义整个压掉——`hr read doc section` 在 CLI 是合法定位，在 MCP 永远查无此人。
// 契约：跟 CLI 同一个 `locateTarget`（selector 优先、够不着的字符再试 id、两跳都败才报错）。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codeOf, isErrorResultOf, sessionOf, textOf } from "./harness";

const DOC = [
  '<!doctype html><html><body><article data-hr-id="hr-0">',
  '<section data-hr-id="s1"><p data-hr-id="p-1">第一段</p></section>',
  '<section data-hr-id="s2"><img data-hr-id="i-1" alt="占位"></section>',
  "</article></body></html>",
].join("");

const call = async (nodeId: string): Promise<{ isError: boolean; code: string; text: string }> => {
  const session = await sessionOf();
  const result = await session.client.callTool({
    name: "hr_read_node",
    arguments: { filePath: "doc.html", nodeId },
  });
  await session.close();
  return { isError: isErrorResultOf(result), code: codeOf(result), text: textOf(result) };
};

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hreader-mcp-read-node-"));
  process.chdir(workspace);
  await writeFile(join(workspace, "doc.html"), DOC, "utf8");
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

describe("hr_read_node · 目标解析", () => {
  it("should read a node by its data-hr-id like before", async () => {
    const result = await call("p-1");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("第一段");
  });

  it("should reject a nodeId crafted to rewrite the selector instead of returning the wrong node", async () => {
    // `x"],[data-hr-id="i-1` 拼进模板是 `[data-hr-id="x"],[data-hr-id="i-1"]`：
    // 选择器文法对 `]` 后接字符判非法——注入造不出第二条选择器，只能报错。
    // 换 locateTarget 后这条仍必须是错误（不能变成静默返回别的节点）。
    const result = await call('x"],[data-hr-id="i-1');

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("占位");
  });

  it("should resolve a bare tag name like the CLI does (selector-first)", async () => {
    // CLI `hr read doc section` 把输入当选择器解析（命中首棵 <section>）；MCP 旧模板把
    // "section" 当 id 查（永远查无此 id → node_not_found）。两边必须同一行为。
    const result = await call("section");

    expect(result.isError).toBe(false);
    expect(result.text).toContain("第一段");
  });
});
