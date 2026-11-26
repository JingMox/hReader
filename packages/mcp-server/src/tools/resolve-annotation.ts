// This layer: `hr_resolve_annotation` (marks a pending annotation resolved); the write goes through core's patch pipeline.

import { nodePatchDeps, resolveAnnotation } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { FILE_PATH_HINT, coreFailureOf, documentTargetOf } from "./target";

export const resolveAnnotationShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
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
    ).catch((error: unknown) => {
      throw coreFailureOf(error, target);
    });
    return okResult(result);
  });
