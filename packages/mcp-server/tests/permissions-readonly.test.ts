// 这层管：agent 面只读权限的钉子——MCP 工具清单里绝不能出现任何能写授权的工具。
// 外来 HTML 的「脚本 / 联网」两个权限维只由用户在阅读器界面里开启；
// agent 侧（MCP 工具、CLI 命令）没有任何写权限的入口，这条测试把它锁死。
//
// 它会因为什么而红：
// - 有人注册了一个名字/参数暗示授权写入的工具（hr_trust、hr_permissions、set_grant…）；
// - 既有工具的 schema 里混进了 trust/permission/grant 参数（功能寄生）。

import { describe, expect, it } from "vitest";

import { isRecord, sessionOf } from "./harness";

/** 授权面在工具名或参数名里的特征词（大小写不敏感）。 */
const PERMISSION_SURFACE = /trust|permission|grant|perm/i;

interface ListedTool {
  readonly name: string;
  readonly parameters: readonly string[];
}

const toolsOf = async (): Promise<readonly ListedTool[]> => {
  const session = await sessionOf();
  const listed: unknown = await session.client.listTools();
  await session.close();
  const tools: unknown = isRecord(listed) ? listed["tools"] : undefined;
  if (!Array.isArray(tools)) throw new Error("tools/list 没有 tools 数组");

  return tools.map((raw: unknown) => {
    const tool = isRecord(raw) ? raw : {};
    const schema: unknown = tool["inputSchema"];
    const properties: unknown = isRecord(schema) ? schema["properties"] : undefined;
    return {
      name: String(tool["name"]),
      parameters: isRecord(properties) ? Object.keys(properties) : [],
    };
  });
};

describe("agent surface · permissions are read-only", () => {
  it("should expose no tool capable of writing doc grants or global modes", async () => {
    const tools = await toolsOf();

    for (const tool of tools) {
      expect(
        PERMISSION_SURFACE.test(tool.name),
        `tool ${tool.name} looks like a permission write surface`,
      ).toBe(false);
      for (const parameter of tool.parameters) {
        expect(
          PERMISSION_SURFACE.test(parameter),
          `tool ${tool.name} takes permission-like parameter ${parameter}`,
        ).toBe(false);
      }
    }
  });

  it("should keep the tool list free of trust/permission entries", async () => {
    const tools = await toolsOf();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "hr_outline",
        "hr_read_node",
        "hr_patch_node",
        "hr_apply_style",
        "hr_resolve_annotation",
        "hr_create_doc",
        "hr_import_doc",
        "hr_undo",
      ]),
    );
    expect(names.every((name) => name.startsWith("hr_"))).toBe(true);
  });
});
