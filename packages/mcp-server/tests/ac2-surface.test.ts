// 这层管：AC-2 里"tool list 必须带 zod 生成的 inputSchema"与"description 写何时用"这两条散装契约。
// 现有 `stdio.test.ts` 只比了**工具名**：名字对而 schema 缺失/手写跑偏，它照样绿。
//
// 它会因为什么而红：
// - `tools/list` 里某个工具没有 `inputSchema`（宿主无法自描述，只能靠猜参）；
// - schema 的必填键与卡片的表不一致（少一个必填 = 模型可以合法地不传；多一个 = 合法调用被拒）；
// - `description` 退化成参数名复述或空串。

import { describe, expect, it } from "vitest";

import { isRecord, sessionOf } from "./harness";

/** 卡片 AC-2 的表：工具 → 必填参数。 */
const REQUIRED_BY_TOOL: Record<string, readonly string[]> = {
  hr_outline: ["filePath"],
  hr_read_node: ["filePath", "nodeId"],
  hr_patch_node: ["filePath", "nodeId", "action", "htmlContent"],
  hr_apply_style: ["filePath"],
  hr_resolve_annotation: ["filePath", "annotationId"],
  hr_create_doc: ["filePath", "title"],
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
  if (!Array.isArray(tools)) throw new Error("tools/list 没有 tools 数组");

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

describe("工具自我描述（AC-2）", () => {
  it("should carry a zod-derived inputSchema for every tool, with the required keys the card names", async () => {
    const tools = await toolsOf();

    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(REQUIRED_BY_TOOL).sort());
    for (const tool of tools) {
      // 手写 schema 的典型症状：没有 `type: object`（上面已断）或 properties 空。
      expect(tool.properties.length).toBeGreaterThan(0);
      const expected = REQUIRED_BY_TOOL[tool.name];
      if (expected === undefined) throw new Error(`卡片上没有登记的工具：${tool.name}`);
      expect([...tool.required].sort()).toEqual([...expected].sort());
      // 必填项必须真的在 properties 里，否则宿主渲染不出该参数。
      for (const key of tool.required) expect(tool.properties).toContain(key);
    }
  });

  it("should explain when to use each tool instead of restating the parameter names", async () => {
    const tools = await toolsOf();

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      // 参数名复述的典型形状：`filePath: string` / `nodeId`。
      expect(tool.description).not.toMatch(/^[a-zA-Z]+\s*:/u);
      expect(tool.description).not.toBe(tool.name);
    }
  });
});
