// This layer: `hr_outline` (outline + pending annotations); parsing and traversal are all in core.
// Sidecar pending annotations ride as an additive `sidecarAnnotations` block: it is computed
// against the same bytes the outline was built from (one read, one relocation domain), and a doc
// without a sidecar store returns output identical to before — no new keys appear.

import {
  buildOutline,
  docRelocatorOf,
  nodePatchDeps,
  parseHtml,
  readAnnotations,
  readSidecarFile,
  resolveTarget,
} from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { annotationEntryBody } from "./annotation-wire";
import {
  FILE_PATH_HINT,
  coreFailureOf,
  corePathsOf,
  documentTargetOf,
  readInsideWorkspace,
  type DocumentTarget,
} from "./target";

export const outlineShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
};

type OutlineArgs = z.infer<z.ZodObject<typeof outlineShape>>;

/**
 * Pending sidecar entries plus store diagnostics, or `{}` when there is nothing to report:
 * absent store and clean-but-empty store both collapse to "no sidecar block" so the base
 * contract stays byte-identical. A meta/sidecar id collision keeps meta's copy (already inside
 * `pendingAnnotations`) and says so in `sidecarDiagnostics`, same wording as `listDocAnnotations`.
 */
const sidecarPartOf = async (
  target: DocumentTarget,
  text: string,
): Promise<Record<string, unknown>> => {
  const resolved = await corePathsOf(target)
    .then((paths) => resolveTarget(paths, nodePatchDeps.fs))
    .catch((error: unknown) => {
      /* v8 ignore next — the doc was already read inside the workspace: realpath and the boundary re-check can only fail on a delete-in-flight race */
      throw coreFailureOf(error, target);
    });
  const file = await readSidecarFile(resolved, nodePatchDeps).catch((error: unknown) => {
    throw coreFailureOf(error, target);
  });
  if (!file.exists) return {};
  const metaIds = new Set(readAnnotations(text).annotations.map((annotation) => annotation.id));
  const relocate = docRelocatorOf(text);
  const diagnostics = [...file.diagnostics];
  const annotations = file.annotations.flatMap((annotation) => {
    if (metaIds.has(annotation.id)) {
      diagnostics.push(
        `批注 ${annotation.id} 同时存在于 hr-meta 与侧车，以 hr-meta 为准，已忽略侧车条目`,
      );
      return [];
    }
    if (annotation.status !== "pending") return [];
    return [annotationEntryBody({ source: "sidecar", annotation, anchor: relocate(annotation) })];
  });
  const out: Record<string, unknown> = {};
  if (annotations.length > 0) out["sidecarAnnotations"] = annotations;
  if (diagnostics.length > 0) out["sidecarDiagnostics"] = diagnostics;
  return out;
};

export const outlineCall = (args: OutlineArgs): Promise<CallToolResult> =>
  guarded("hr_outline", async () => {
    const target = documentTargetOf(args.filePath, process.cwd());
    const text = await readInsideWorkspace(target);
    const sidecar = await sidecarPartOf(target, text);
    return okResult({ ...buildOutline(parseHtml(text)), ...sidecar });
  });
