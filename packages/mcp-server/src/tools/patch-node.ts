// This layer: `hr_patch_node` (the only write tool); transform, atomic write, and undo snapshots are all done by core's `patchFile`.

import { nodePatchDeps, patchFile } from "@hreader/core";
import type { PatchAction, PatchRequest } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { docIdOf, UI_URI_PREFIX } from "../ui";
import { FILE_PATH_HINT, coreFailureOf, documentTargetOf } from "./target";

/** Same set as core's `PatchAction`; written as `satisfies` so a rename in core turns red at compile time here. */
const ACTIONS = [
  "replace",
  "insert_before",
  "insert_after",
  "append",
  "delete",
] as const satisfies readonly PatchAction[];

export const patchNodeShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
  nodeId: z.string().min(1).describe("目标节点的 `data-hr-id`；要换整篇内容用 `root`"),
  action: z
    .enum(ACTIONS)
    .describe("replace 换掉该节点；insert_before/after 插兄弟；append 插子节点；delete 删该节点"),
  htmlContent: z
    .string()
    .describe("新片段（`delete` 时留空串即可）；片段必须是允许的正文标签，脚本/样式会被拒"),
};

type PatchNodeArgs = z.infer<z.ZodObject<typeof patchNodeShape>>;

/** `delete` must carry no html; the other four must: this fork is delegated to core's types, not re-judged in the adapter. */
const requestOf = (args: PatchNodeArgs): PatchRequest =>
  args.action === "delete"
    ? { targetId: args.nodeId, action: args.action }
    : { targetId: args.nodeId, action: args.action, html: args.htmlContent };

export const patchNodeCall = (args: PatchNodeArgs): Promise<CallToolResult> =>
  guarded("hr_patch_node", async () => {
    const target = documentTargetOf(args.filePath, process.cwd());
    const result = await patchFile(
      { workspace: target.workspace, file: target.file, request: requestOf(args) },
      nodePatchDeps,
    ).catch((error: unknown) => {
      throw coreFailureOf(error, target);
    });
    return okResult(result, { ui: { resourceUri: `${UI_URI_PREFIX}${docIdOf(target.file)}` } });
  });
