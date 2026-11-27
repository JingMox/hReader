// This layer: `hr_outline` (outline + pending annotations); parsing and traversal are all in core.
// Sidecar pending annotations ride as an additive `sidecarAnnotations` block: it is computed
// against the same bytes the outline was built from (one read, one relocation domain), and a doc
// without a sidecar store returns output identical to before — no new keys appear.

import { relative, sep } from "node:path";

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
  // The realpath-domain pair is computed inside the sidecar lookup only — after the doc was
  // already read inside the workspace. On a symlinked cwd an absolute `filePath` spelled
  // lexically makes `target.file` an escaping `../…`, which core's lexical gate would
  // mis-reject; deriving the relative against realpaths restores the in-bounds verdict the
  // read path already gave. The shared target path and its frozen errors stay untouched.
  const [workspaceReal, absoluteReal] = await Promise.all([
    nodePatchDeps.fs.realpath(target.workspace),
    nodePatchDeps.fs.realpath(target.absolute),
  ]).catch((error: unknown) => {
    throw coreFailureOf(error, target);
  });
  // `.hreader/**` docs are hreader's own store files (history snapshots, template index pages):
  // readable on the read gate, but no sidecar can exist for them — `resolveTarget`'s store
  // exclusion is write-domain, so the block is skipped rather than allowed to trip it.
  const relativePath = relative(workspaceReal, absoluteReal).split(sep).join("/");
  if (relativePath === ".hreader" || relativePath.startsWith(".hreader/")) return {};
  const resolved = await resolveTarget({ workspace: workspaceReal, file: relativePath }, nodePatchDeps.fs)
    .catch((error: unknown) => {
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
