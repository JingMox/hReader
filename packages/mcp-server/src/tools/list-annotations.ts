// This layer: `hr_list_annotations` — the merged meta+sidecar annotation view.
// With `filePath` it is that one document's list (same merged read as the server's sidecar
// route); without it, core scans the whole workspace — walked docs plus unreachable-for-the-walk
// store records — bounded by `WORKSPACE_SCAN_LIMITS`, with `truncated` telling apart "prefix of
// reality" from "the whole of it".

import { sep } from "node:path";

import {
  WORKSPACE_SCAN_LIMITS,
  listDocAnnotations,
  listWorkspaceAnnotations,
  nodePatchDeps,
  type AnnotationStatusFilter,
} from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { foldedOf, guarded, okResult } from "../errors";
import { annotationEntryBody } from "./annotation-wire";
import { FILE_PATH_HINT, coreFailureOf, corePathsOf, documentTargetOf } from "./target";

export const listAnnotationsShape = {
  filePath: z
    .string()
    .min(1)
    .optional()
    .describe(`${FILE_PATH_HINT}；省略时扫描整个工作区里所有带批注的文档`),
  status: z
    .enum(["pending", "resolved", "all"])
    .optional()
    .describe("按批注状态过滤：pending 待处理 | resolved 已结 | all 全部（默认）"),
};

type ListAnnotationsArgs = z.infer<z.ZodObject<typeof listAnnotationsShape>>;

const hitsStatus = (filter: AnnotationStatusFilter, status: string): boolean =>
  filter === "all" || filter === status;

/** One doc through core's merged read — the caller-facing relative path rides on every entry so single-doc and scan results share one shape. */
const listOneDoc = async (
  args: { readonly filePath: string },
  status: AnnotationStatusFilter,
): Promise<CallToolResult> => {
  const target = documentTargetOf(args.filePath, process.cwd());
  const paths = await corePathsOf(target).catch((error: unknown) => {
    throw coreFailureOf(error, target);
  });
  const listed = await listDocAnnotations(paths, nodePatchDeps).catch((error: unknown) => {
    throw coreFailureOf(error, target);
  });
  const file = paths.file.split(sep).join("/");
  const entries = listed.annotations
    .filter((entry) => hitsStatus(status, entry.annotation.status))
    .map((entry) => annotationEntryBody(entry, file));
  return okResult({
    annotations: entries.slice(0, WORKSPACE_SCAN_LIMITS.annotations),
    diagnostics: listed.diagnostics.slice(0, WORKSPACE_SCAN_LIMITS.diagnostics),
    docsScanned: 1,
    truncated: entries.length > WORKSPACE_SCAN_LIMITS.annotations,
  });
};

const listWorkspace = async (status: AnnotationStatusFilter): Promise<CallToolResult> => {
  const scanned = await listWorkspaceAnnotations(
    { workspace: process.cwd(), status },
    nodePatchDeps,
  ).catch((error: unknown) => {
    // No user path to echo here: core messages carry absolute paths, folded like the other core-wording spots.
    /* v8 ignore next — the only throw is realpath(cwd) failing, i.e. the server outliving its own workspace */
    throw foldedOf(error);
  });
  return okResult({
    annotations: scanned.annotations.map((entry) => annotationEntryBody(entry, entry.file)),
    diagnostics: scanned.diagnostics,
    docsScanned: scanned.docsScanned,
    truncated: scanned.truncated,
  });
};

export const listAnnotationsCall = (args: ListAnnotationsArgs): Promise<CallToolResult> =>
  guarded("hr_list_annotations", async () => {
    const status = args.status ?? "all";
    return args.filePath === undefined
      ? listWorkspace(status)
      : listOneDoc({ filePath: args.filePath }, status);
  });
