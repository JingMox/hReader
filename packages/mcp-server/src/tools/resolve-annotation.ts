// This layer: `hr_resolve_annotation` (marks a pending annotation resolved); the write goes through core's patch pipeline.
// Meta (hr-meta) is tried first — the only `not_found` it can raise is "the id is not among the
// meta annotations" — and the sidecar store is the fallback, so one tool resolves both store
// kinds. `source` rides along additively; every other failure path (missing doc, lock, usage)
// keeps the frozen codes and wording unchanged.

import { nodePatchDeps, resolveAnnotation, resolveSidecarAnnotation } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { FILE_PATH_HINT, codeOf, coreFailureOf, documentTargetOf } from "./target";

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
    const input = {
      workspace: target.workspace,
      file: target.file,
      id: args.annotationId,
      ...(args.resolutionNote === undefined ? {} : { resolutionNote: args.resolutionNote }),
    };
    const meta = await resolveAnnotation(input, nodePatchDeps).catch((error: unknown) => {
      // Meta reports a bare `not_found` only when the id is not a meta annotation — fall through
      // to the sidecar store. Every other failure (doc missing, lock timeout) ends here.
      if (codeOf(error) !== "not_found") throw coreFailureOf(error, target);
      return undefined;
    });
    if (meta !== undefined) return okResult({ ...meta, source: "meta" });
    const sidecar = await resolveSidecarAnnotation(input, nodePatchDeps).catch((error: unknown) => {
      throw coreFailureOf(error, target);
    });
    return okResult({ ...sidecar, source: "sidecar" });
  });
