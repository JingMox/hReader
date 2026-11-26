// This layer: `hr new` (draft a document shape + apply theme -> atomic write); no argument checks, no exit codes.
// `<file>`'s write rules are the same set as `hr export --out` (parent dir -> out-of-bounds -> exists); no second copy.

import { dirname, resolve } from "node:path";

import {
  HrError,
  isInside,
  loadThemeCss,
  newDocumentHtml,
  nodePatchDeps,
  nodeStyleDeps,
  replaceTheme,
  type DocKind,
} from "@hreader/core";

import { dataNew, humanNew, jsonOk } from "../output";
import { assertTargetFreeOf, assertWritableDirOf, writeOutOf } from "./export-print";

const encoder = new TextEncoder();

export interface NewDocInput {
  /** Absolute path (the dispatch layer already realpathed it). */
  readonly path: string;
  readonly docKind: DocKind;
  readonly title: string;
  readonly visual: string;
  readonly workspace: string;
  readonly force: boolean;
  readonly json: boolean;
  /** Path printed in the receipt (user's view): falls back to the real path when not given. */
  readonly displayPath?: string | undefined;
}

export const newDocCommand = async (input: NewDocInput): Promise<string> => {
  // Resolve the theme first: an unknown theme fails before any write, leaving no unstyled half-product.
  const css = await loadThemeCss(input.visual, nodeStyleDeps(input.workspace));
  const skeleton = newDocumentHtml({ kind: input.docKind, title: input.title });
  const data = encoder.encode(replaceTheme(skeleton, css).html);
  // Same order as `hr export --out`: io (parent dir) -> out-of-bounds -> exists, so exit codes stay a stable 3/3/1.
  await assertWritableDirOf(dirname(input.path), nodePatchDeps);
  if (!isInside(input.workspace, resolve(input.path))) {
    throw new HrError("path_outside_workspace", `新文档只能建在 workspace 内：${input.path}`);
  }
  await assertTargetFreeOf(input.path, input.force, nodePatchDeps);
  await writeOutOf({ path: input.path, workspace: input.workspace, data, what: "写入新文档" });
  const report = {
    path: input.path,
    kind: input.docKind,
    title: input.title,
    bytes: data.length,
  };
  return input.json ? jsonOk(dataNew(report)) : humanNew(report, input.displayPath ?? input.path);
};
