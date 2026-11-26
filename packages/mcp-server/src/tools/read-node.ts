// This layer: `hr_read_node` (one node's HTML + its annotations); slicing/truncation are all in core's `readNode`.

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
    // Same resolution path as CLI `hr read`: selector first, id as fallback, error only after both hops fail —
    // we no longer hand-build `[data-hr-id="…"]` (that would flatten away the whole "input is a selector" layer of meaning).
    return okResult(readNode(parsed, locateTarget(parsed, args.nodeId).selector));
  });
