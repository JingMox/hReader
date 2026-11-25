// 这层管：`hr_read_node`（一个节点的 HTML + 它身上的批注）；切片/截断全在 core 的 `readNode`。

import { locateTarget, parseHtml, readNode } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { FILE_PATH_HINT, documentTargetOf, readInsideWorkspace } from "./target";

export const readNodeShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
  nodeId: z
    .string()
    .min(1)
    .describe("`hr_outline` 里给出的节点 id（`data-hr-id`）；写稿前先读它，别凭大纲猜正文"),
};

type ReadNodeArgs = z.infer<z.ZodObject<typeof readNodeShape>>;

export const readNodeCall = (args: ReadNodeArgs): Promise<CallToolResult> =>
  guarded("hr_read_node", async () => {
    const text = await readInsideWorkspace(documentTargetOf(args.filePath, process.cwd()));
    const parsed = parseHtml(text);
    // 与 CLI `hr read` 同一条解析路径：selector 优先、id 兜底、两跳都败才报错——
    // 不再自拼 `[data-hr-id="…"]`（那会把"选择器输入"这层语义整个压掉）。
    return okResult(readNode(parsed, locateTarget(parsed, args.nodeId).selector));
  });
