// 这层管：`hr_resolve_annotation`（把 pending_ai 批注标成 resolved）；写回走 core 的 patch 管线。

import { nodePatchDeps, resolveAnnotation } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { documentTargetOf } from "./target";

export const resolveAnnotationShape = {
  filePath: z.string().min(1).describe("带批注的 HTML 文档路径（相对当前目录或绝对路径）"),
  annotationId: z
    .string()
    .min(1)
    .describe("`hr_outline` 里 `pendingAnnotations[].id` 的那个 id；处理完一条再处理下一条"),
  resolutionNote: z
    .string()
    .optional()
    .describe("一句话说明改了什么，会写进批注的 `resolutionNote`"),
};

type ResolveAnnotationArgs = z.infer<z.ZodObject<typeof resolveAnnotationShape>>;

export const resolveAnnotationCall = (args: ResolveAnnotationArgs): Promise<CallToolResult> =>
  guarded("hr_resolve_annotation", async () => {
    const target = documentTargetOf(args.filePath, process.cwd());
    const result = await resolveAnnotation(
      {
        workspace: target.workspace,
        file: target.file,
        id: args.annotationId,
        ...(args.resolutionNote === undefined ? {} : { resolutionNote: args.resolutionNote }),
      },
      nodePatchDeps,
    );
    return okResult(result);
  });
