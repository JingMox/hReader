// This layer: assembly (pure wiring — no IO, no argv reads). Both transports share this one registry.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { registerTools } from "./tools";

/** Same value as `package.json`'s `version`; change both together (not read from disk at runtime). */
export const SERVER_VERSION = "1.1.0";

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
