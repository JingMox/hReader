// This layer: assembly (pure wiring — no IO, no argv reads). Both transports share this one registry.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { registerTools } from "./tools";

/** Same value as `package.json`'s `version`; change both together (not read from disk at runtime). */
export const SERVER_VERSION = "1.1.0";

/** What the host should reach for first, and which tool family covers which job — sent verbatim in the `initialize` result. */
const INSTRUCTIONS = [
  "hReader 文档操作：hr_outline 看结构、hr_read_node 读节点正文、hr_patch_node 改节点、hr_undo 撤销最近一次写；",
  "起稿走 hr_create_doc / hr_import_doc / hr_create_from_template；换视觉或取调性走 hr_apply_style；批注列表用 hr_list_annotations、结掉用 hr_resolve_annotation。",
  "模板：hr_list_templates 列出三层可用模板、hr_get_template 读某个模板全文（超长字段截断）、",
  "hr_create_from_template 按模板起稿、hr_save_template 把工作区页面存成模板。",
].join("");

export const createServer = (workspace: string): McpServer => {
  const server = new McpServer(
    { name: "hreader", version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );
  registerTools(server);
  registerResources(server, workspace);
  registerPrompts(server, workspace);
  return server;
};
