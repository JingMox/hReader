// 这层管：装配（纯组装，不含 IO、不读 argv）。两种传输共用这一份注册表（AC-8）。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { registerTools } from "./tools";

/** 与 `package.json` 的 `version` 同值；改版本时两处一起改（不在运行期读盘）。 */
export const SERVER_VERSION = "1.0.0";

export const createServer = (workspace: string): McpServer => {
  const server = new McpServer(
    { name: "hreader", version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  registerTools(server);
  registerResources(server, workspace);
  registerPrompts(server, workspace);
  return server;
};
