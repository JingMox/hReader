// This layer: nails the agent surface's read-only permission — no tool capable of writing grants may ever appear in the MCP tool list.
// Foreign HTML's two permission axes ("scripts" / "network") can only be enabled by the user in the reader UI;
// the agent side (MCP tools, CLI commands) has no write-permission entry at all, and this test pins that shut.
//
// What makes it red:
// - someone registers a tool whose name/parameters imply grant-writing (hr_trust, hr_permissions, set_grant…);
// - an existing tool's schema grows a trust/permission/grant parameter (feature parasitism).

import { describe, expect, it } from "vitest";

import { isRecord, sessionOf } from "./harness";

/** Feature words of the grant surface in tool or parameter names (case-insensitive). */
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
  if (!Array.isArray(tools)) throw new Error("tools/list has no tools array");

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
