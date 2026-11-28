// This layer: two loose contracts — "the tool list must carry a zod-generated inputSchema" and "description says when to use".
// Existing `stdio.test.ts` only compared **tool names**: right names with a missing/handwritten-drifting schema stays green.
//
// What makes it red:
// - some tool in `tools/list` lacks `inputSchema` (the host cannot self-describe and must guess parameters);
// - a schema's required keys diverge from the table below (one missing = the model may legally omit it; one extra = a legal call gets rejected);
// - a `description` degrades into a parameter-name restatement or an empty string.

import { describe, expect, it } from "vitest";

import { isRecord, sessionOf } from "./harness";

/** Contract table: tool → required parameters. */
const REQUIRED_BY_TOOL: Record<string, readonly string[]> = {
  hr_outline: ["filePath"],
  hr_read_node: ["filePath", "nodeId"],
  hr_patch_node: ["filePath", "nodeId", "action", "htmlContent"],
  hr_apply_style: ["filePath"],
  hr_list_annotations: [],
  hr_resolve_annotation: ["filePath", "annotationId"],
  hr_create_doc: ["filePath", "title"],
  hr_import_doc: ["filePath"],
  hr_undo: ["filePath"],
  hr_list_templates: [],
  hr_get_template: ["id"],
  hr_create_from_template: ["target"],
  hr_save_template: ["file", "id"],
  hr_search: ["query"],
  hr_get_meta: ["filePath"],
  hr_set_meta: ["filePath"],
};

interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly required: readonly string[];
  readonly properties: readonly string[];
}

const toolsOf = async (): Promise<readonly ListedTool[]> => {
  const session = await sessionOf();
  const listed: unknown = await session.client.listTools();
  await session.close();
  const tools: unknown = isRecord(listed) ? listed["tools"] : undefined;
  if (!Array.isArray(tools)) throw new Error("tools/list has no tools array");

  return tools.map((raw: unknown) => {
    const tool = isRecord(raw) ? raw : {};
    const description = tool["description"];
    const schema: unknown = tool["inputSchema"];
    const required: unknown = isRecord(schema) ? schema["required"] : undefined;
    const properties: unknown = isRecord(schema) ? schema["properties"] : undefined;
    if (isRecord(schema)) expect(schema["type"]).toBe("object");

    return {
      name: String(tool["name"]),
      description: typeof description === "string" ? description : "",
      required: Array.isArray(required) ? required.map(String) : [],
      properties: isRecord(properties) ? Object.keys(properties) : [],
    };
  });
};

describe("tool self-description", () => {
  it("should carry a zod-derived inputSchema for every tool, with the required keys the card names", async () => {
    const tools = await toolsOf();

    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(REQUIRED_BY_TOOL).sort());
    for (const tool of tools) {
      // The classic symptom of a handwritten schema: no `type: object` (asserted above) or empty properties.
      // `hr_list_templates` legitimately takes zero parameters — only argumented tools must show a non-empty properties map.
      if (tool.required.length > 0) expect(tool.properties.length).toBeGreaterThan(0);
      const expected = REQUIRED_BY_TOOL[tool.name];
      if (expected === undefined)
        throw new Error(`tool not registered in the contract table: ${tool.name}`);
      expect([...tool.required].sort()).toEqual([...expected].sort());
      // Required keys must really sit inside properties, or the host cannot render the parameter.
      for (const key of tool.required) expect(tool.properties).toContain(key);
    }
  });

  it("should explain when to use each tool instead of restating the parameter names", async () => {
    const tools = await toolsOf();

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      // The classic shape of parameter-name restatement: `filePath: string` / `nodeId`.
      expect(tool.description).not.toMatch(/^[a-zA-Z]+\s*:/u);
      expect(tool.description).not.toBe(tool.name);
    }
  });
});
