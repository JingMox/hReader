// 这层管：`resources/*`。风格源文本一条（`hreader://styles/{id}`）+ MCP-UI 视图一条
// （`ui://hreader/view/{docId}`）；读取不依赖 daemon 是否在跑。

import {
  BUILTIN_STYLES,
  discoverStyles,
  HrError,
  nodeStyleDeps,
  readStyleSource,
} from "@hreader/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListResourcesRequestSchema,
  type ReadResourceResult,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { UI_MIME_TYPE, UI_URI_PREFIX, relativePathOfDocId, viewHtmlOf } from "./ui";

export const STYLE_URI_PREFIX = "hreader://styles/";

const unique = (ids: readonly string[]): readonly string[] => [...new Set(ids)].sort();

/** `discoverStyles()` 只收 project/user，内置档由本层并入（`presets/*.ts` 不在盘上）。 */
export const styleIdsOf = async (workspace: string): Promise<readonly string[]> => {
  const discovery = await discoverStyles(nodeStyleDeps(workspace));
  return unique([
    ...BUILTIN_STYLES.map((style) => style.id),
    ...discovery.styles.map((style) => style.id),
  ]);
};

const styleResourceOf = (id: string): { uri: string; name: string; mimeType: string } => ({
  uri: `${STYLE_URI_PREFIX}${id}`,
  name: `风格：${id}`,
  mimeType: "application/yaml",
});

const readStyle = async (id: string, workspace: string): Promise<ReadResourceResult> => {
  const source = await readStyleSource(id, nodeStyleDeps(workspace));
  return {
    contents: [
      {
        uri: `${STYLE_URI_PREFIX}${id}`,
        mimeType: "application/yaml",
        text: source.yaml,
        // 宿主需要知道这份文本是盘上的原文还是内置档的序列化产物。
        _meta: { origin: source.origin },
      },
    ],
  };
};

const readView = async (docId: string): Promise<ReadResourceResult> => {
  const relativePath = relativePathOfDocId(docId);
  const text =
    relativePath === undefined ? undefined : await viewHtmlOf(relativePath).catch(() => undefined);
  return {
    contents: [
      {
        uri: `${UI_URI_PREFIX}${docId}`,
        mimeType: UI_MIME_TYPE,
        text: text ?? "<!doctype html><p>视图已失效：文档 id 无法解析。</p>",
      },
    ],
  };
};

const readUri = async (uri: string, workspace: string): Promise<ReadResourceResult> => {
  if (uri.startsWith(STYLE_URI_PREFIX)) {
    return readStyle(uri.slice(STYLE_URI_PREFIX.length), workspace);
  }
  if (uri.startsWith(UI_URI_PREFIX)) return readView(uri.slice(UI_URI_PREFIX.length));
  throw new HrError("not_found", `未知资源：${uri}`);
};

export const registerResources = (server: McpServer, workspace: string): void => {
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: (await styleIdsOf(workspace)).map(styleResourceOf),
  }));
  // 抛出的 HrError 由 SDK 转成 JSON-RPC error：这里不再包一层，否则错误码会丢成字符串文本。
  server.server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    readUri(request.params.uri, workspace),
  );
};
