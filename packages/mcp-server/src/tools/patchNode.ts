// 这层管：`hr_patch_node`（唯一的落盘工具）；变换、原子写、undo 快照全部由 core 的 `patchFile` 负责。

import { nodePatchDeps, patchFile } from "@hreader/core";
import type { PatchAction, PatchRequest } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { docIdOf, UI_URI_PREFIX } from "../ui";
import { documentTargetOf } from "./target";

/** 与 core 的 `PatchAction` 同集合；写成 `satisfies` 让 core 改名时这里编译期就红。 */
const ACTIONS = [
  "replace",
  "insert_before",
  "insert_after",
  "append",
  "delete",
] as const satisfies readonly PatchAction[];

export const patchNodeShape = {
  filePath: z.string().min(1).describe("要改的 HTML 文档路径（相对当前目录或绝对路径）"),
  nodeId: z.string().min(1).describe("目标节点的 `data-hr-id`；要换整篇内容用 `root`"),
  action: z
    .enum(ACTIONS)
    .describe("replace 换掉该节点；insert_before/after 插兄弟；append 插子节点；delete 删该节点"),
  htmlContent: z
    .string()
    .describe("新片段（`delete` 时留空串即可）；片段必须是允许的正文标签，脚本/样式会被拒"),
};

type PatchNodeArgs = z.infer<z.ZodObject<typeof patchNodeShape>>;

/** `delete` 必须不带 html，其余四种必带：这个分叉交给 core 的类型，不在适配层重判。 */
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
    );
    return okResult(result, { ui: { resourceUri: `${UI_URI_PREFIX}${docIdOf(target.file)}` } });
  });
