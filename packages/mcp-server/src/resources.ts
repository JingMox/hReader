// This layer: `resources/*`. One style-source resource (`hreader://styles/{id}`) + one MCP-UI view resource
// (`ui://hreader/view/{docId}`); reads do not depend on the daemon running.

import {
  BUILTIN_STYLES,
  cutAtCodePoint,
  discoverStyles,
  HrError,
  readStyleSource,
} from "@hreader/core";
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

/** `discoverStyles()` only returns project/user styles; builtin ones are merged in at this layer (`presets/*.ts` are not on disk). */
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
        // The host needs to know whether this text is the on-disk original or the serialized form of a builtin preset.
        _meta: { origin: source.origin },
      },
    ],
  };
};

const readView = async (docId: string): Promise<ReadResourceResult> => {
  const relativePath = relativePathOfDocId(docId);
  if (relativePath === undefined) {
    throw new HrError("not_found", `视图已失效：文档 id 无法解析（${cutAtCodePoint(docId, 32)}）`);
  }
  const target = documentTargetOf(relativePath, process.cwd());
  const text = await viewHtmlOf(target).catch((error: unknown) => {
    // docId comes out of a base64url decode; reporting garbage as a path to the model is meaningless: just answer "this document does not exist".
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
  // Failures must become coded JSON-RPC errors: `-32603 Internal error` is "misattribution" — the host cannot route on it.
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      return await readUri(request.params.uri, workspace);
    } catch (error: unknown) {
      logFailure("resources/read", error);
      throw rpcErrorOf(foldedOf(error));
    }
  });
};
