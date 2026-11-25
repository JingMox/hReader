// 这层管：错误码的诚实性（防"错误归因"：说错原因比缺功能更贵）。
//
// 它会因为什么而红：
// - 某类失败被归到 `[internal]`（等于告诉宿主"我们炸了"，而其实是入参/目标的问题）；
// - 一类失败出现两个码（宿主按码分流就会分叉）；
// - 文案里出现 node 的原始 errno（`ENOENT:` / `EISDIR:` / `ENAMETOOLONG:`）——那是实现细节，
//   宿主既不能据此重试也不能改参数，只能把它原样塞进日志。
//
// 注意：文案里连绝对路径都不许出现——`errors.ts` 的 `humanMessageOf` 会把工作区根折成相对，
// 所以对**所有**码都一刀切；越界时用户看到的是自己传进来的那条相对路径。

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ANNOTATED_DOC,
  codeOf,
  isErrorResultOf,
  leaveWorkspace,
  sessionOf,
  textOf,
  workspaceIn,
} from "./harness";

let workspace = "";

beforeEach(async () => {
  workspace = await workspaceIn("hreader-mcp-errors-");
  process.chdir(workspace);
});

afterEach(async () => {
  await leaveWorkspace(workspace);
});

const RAW_ERRNO = ["ENOENT", "EISDIR", "ENAMETOOLONG", "ENOTDIR", "EACCES", "EPERM"];

interface Case {
  readonly name: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /**
   * 允许的 `HrError.code` 集合：具体选哪个是实现的选择（core 词表里 `not_a_file` 与 `not_found` 都先有先例），
   * 本用例只锁两件不该含糊的事——**不许 `internal` 当垃圾桶**、且**同一类失败只有一个码**（集合只放同语义的近邻）。
   */
  readonly codes: readonly string[];
  readonly prepare?: () => Promise<void>;
}

const CASES: readonly Case[] = [
  {
    name: "读一个不存在的文档",
    tool: "hr_outline",
    args: { filePath: "nope.html" },
    codes: ["not_found"],
  },
  {
    name: "改一个不存在的节点",
    tool: "hr_patch_node",
    args: {
      filePath: "doc.html",
      nodeId: "hr-deadbeef",
      action: "replace",
      htmlContent: "<p>x</p>",
    },
    codes: ["node_not_found"],
  },
  {
    name: "改一个不存在的文档",
    tool: "hr_patch_node",
    args: { filePath: "ghost.html", nodeId: "root", action: "replace", htmlContent: "<p>x</p>" },
    codes: ["not_found"],
  },
  {
    name: "建一份已存在的文档",
    tool: "hr_create_doc",
    args: { filePath: "doc.html", title: "撞名" },
    codes: ["file_exists"],
  },
  {
    name: "要求一份不存在的风格",
    tool: "hr_apply_style",
    args: { filePath: "doc.html", visualId: "no-such-style" },
    codes: ["unknown_style"],
  },
  {
    name: "两样都不给（visualId 与 toneId 全空）",
    tool: "hr_apply_style",
    args: { filePath: "doc.html" },
    codes: ["invalid_input"],
  },
  {
    name: "超长路径",
    tool: "hr_create_doc",
    args: { filePath: `${"a/".repeat(2500)}x.html`, title: "太长" },
    codes: ["invalid_input"],
  },
  {
    name: "把目录当文档读",
    tool: "hr_outline",
    args: { filePath: "sub" },
    codes: ["not_a_file"],
    prepare: async () => {
      await mkdir(join(workspace, "sub"), { recursive: true });
    },
  },
];

const runCase = async (row: Case): Promise<{ code: string; text: string }> => {
  await row.prepare?.();
  const session = await sessionOf();
  const result: unknown = await session.client.callTool({
    name: row.tool,
    arguments: row.args,
  });
  await session.close();
  expect(isErrorResultOf(result)).toBe(true);
  return { code: codeOf(result), text: textOf(result) };
};

describe("错误码诚实性 · 每类失败一个码、一个原因", () => {
  it.each(CASES)(
    "$name → 诚实码，不是 internal",
    async (row) => {
      await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
      const { code, text } = await runCase(row);

      expect(row.codes).toContain(code);
      // 正文里只许出现一个码，且就是它自己（`[code] message`）。
      expect(text.startsWith(`[${code}] `)).toBe(true);
      expect(text.match(/^\[[a-z_]+\]/gu)).toHaveLength(1);
      for (const errno of RAW_ERRNO) expect(text).not.toContain(errno);
      // 绝对路径同样不许进正文：用户看到的是自己传进来的相对路径。
      expect(text).not.toContain(workspace);
    },
    30_000,
  );
});

describe("错误码诚实性 · 同一份源的两个出口不许各说各话", () => {
  it("should report an unknown style with one code through the resource and through the tool", async () => {
    await writeFile(join(workspace, "doc.html"), ANNOTATED_DOC, "utf8");
    const session = await sessionOf();
    const tool = await session.client.callTool({
      name: "hr_apply_style",
      arguments: { filePath: "doc.html", visualId: "no-such-style" },
    });
    const resource = await session.client
      .readResource({ uri: "hreader://styles/no-such-style" })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await session.close();

    expect(codeOf(tool)).toBe("unknown_style");
    // 资源那条走的是 JSON-RPC error（没有工具结果的壳）：`McpError` 的 `message` 与 `code` 都要能读。
    const rpcCode: unknown = Reflect.get(Object(resource), "code");
    const rpcMessage: unknown = Reflect.get(Object(resource), "message");
    // 实测：`rpcCode` 恒为 -32603，只有 `message` 里带着真原因——"码对了文案错"与"文案对了码错"
    // 对宿主是同一件事：它没法按码分流。这条断言就是"资源出口也得有真码"的探针。
    expect(rpcMessage).toContain("no-such-style");
    // `-32603 Internal error` 是 SDK 的兜底码：业务失败落在这里就等于"错误归因"。
    expect(rpcCode).not.toBe(-32603);
  }, 30_000);
});
