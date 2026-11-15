// 这层管：`hr_read_node`（一个节点的 HTML + 它身上的批注）；切片/截断全在 core 的 `readNode`。

import { parseHtml, readNode } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { documentTargetOf, readInsideWorkspace } from "./target";

export const readNodeShape = {
  filePath: z.string().min(1).describe("含该节点的 HTML 文档路径（相对当前目录或绝对路径）"),
  nodeId: z
    .string()
    .min(1)
    .describe("`hr_outline` 里给出的节点 id（`data-hr-id`）；写稿前先读它，别凭大纲猜正文"),
};

type ReadNodeArgs = z.infer<z.ZodObject<typeof readNodeShape>>;

export const readNodeCall = (args: ReadNodeArgs): Promise<CallToolResult> =>
  guarded("hr_read_node", async () => {
    const text = await readInsideWorkspace(documentTargetOf(args.filePath, process.cwd()));
    return okResult(readNode(parseHtml(text), `[data-hr-id="${args.nodeId}"]`));
  });
