// 这层管：`resources/*`。风格源文本一条（`hreader://styles/{id}`）+ MCP-UI 视图一条
// （`ui://hreader/view/{docId}`）；读取不依赖 daemon 是否在跑。

import { BUILTIN_STYLES, discoverStyles, HrError, readStyleSource } from "@hreader/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListResourcesRequestSchema,
  type ReadResourceResult,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { foldedOf, rpcErrorOf } from "./errors";
import { logFailure } from "./log";
import { styleDepsOf } from "./style-deps";
import { documentTargetOf } from "./tools/target";
import { UI_MIME_TYPE, UI_URI_PREFIX, relativePathOfDocId, viewHtmlOf } from "./ui";

export const STYLE_URI_PREFIX = "hreader://styles/";

const unique = (ids: readonly string[]): readonly string[] => [...new Set(ids)].sort();

/** `discoverStyles()` 只收 project/user，内置档由本层并入（`presets/*.ts` 不在盘上）。 */
export const styleIdsOf = async (workspace: string): Promise<readonly string[]> => {
  const discovery = await discoverStyles(styleDepsOf(workspace));
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
  const source = await readStyleSource(id, styleDepsOf(workspace));
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
  if (relativePath === undefined) {
    throw new HrError("not_found", `视图已失效：文档 id 无法解析（${docId.slice(0, 32)}）`);
  }
  const target = documentTargetOf(relativePath, process.cwd());
  const text = await viewHtmlOf(target).catch((error: unknown) => {
    // docId 是 base64url 解出来的，乱码当路径报给模型没有意义：回"这份文档不存在"就好。
    if (error instanceof HrError && error.code === "not_found") {
      throw new HrError("not_found", `视图已失效：${docId} 对应的文档不存在`, { cause: error });
    }
    throw error;
  });
  return {
    contents: [{ uri: `${UI_URI_PREFIX}${docId}`, mimeType: UI_MIME_TYPE, text }],
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
  // 失败必须变成带码的 JSON-RPC error：`-32603 Internal error` 等于"错误归因"，宿主没法按码分流。
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      return await readUri(request.params.uri, workspace);
    } catch (error: unknown) {
      logFailure("resources/read", error);
      throw rpcErrorOf(foldedOf(error));
    }
  });
};
