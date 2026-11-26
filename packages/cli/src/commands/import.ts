// This layer: `hr import` (read foreign HTML -> importForeign -> atomically write a managed document); no argument checks, no exit codes.
// `<out>`'s write rules are the same set as `hr export --out` (parent dir -> out-of-bounds -> exists); no second copy of the logic.

import { dirname } from "node:path";

import { importForeign, nodePatchDeps, type DocKind } from "@hreader/core";

import { readTextFile } from "../input";
import { dataImport, humanImport, jsonOk } from "../output";
import {
  assertOutInsideOf,
  assertTargetFreeOf,
  assertWritableDirOf,
  writeOutOf,
} from "./export-print";

const encoder = new TextEncoder();

export interface ImportDocInput {
  /** Foreign HTML source file (real absolute path). */
  readonly path: string;
  /** Destination (real absolute path): the intent layer already substituted `<name>.hr.html` for a missing `--out`. */
  readonly out: string;
  /** `undefined` without `--kind`: the default shape is core's call; this layer invents no default. */
  readonly docKind: DocKind | undefined;
  readonly title: string | undefined;
  readonly workspace: string;
  readonly force: boolean;
  readonly json: boolean;
  /** The `<out>` printed in the receipt (user's view): falls back to the real path when not given. */
  readonly displayOut?: string | undefined;
}

export const importDocCommand = async (input: ImportDocInput): Promise<string> => {
  // Convert before checking the write: when conversion fails (source is already managed) the target path is not probed and no half-product is left.
  const product = importForeign(await readTextFile(input.path), {
    ...(input.docKind === undefined ? {} : { kind: input.docKind }),
    ...(input.title === undefined ? {} : { title: input.title }),
  });
  const data = encoder.encode(product.html);
  // Same order as `hr export --out`: io (unwritable parent) -> out-of-bounds -> exists, so exit codes stay a stable 3/3/1.
  await assertWritableDirOf(dirname(input.out), nodePatchDeps);
  assertOutInsideOf(input.out, input.workspace);
  await assertTargetFreeOf(input.out, input.force, nodePatchDeps);
  await writeOutOf({ path: input.out, workspace: input.workspace, data, what: "写入导入文档" });
  return input.json
    ? jsonOk(dataImport(input.out, data.length, product.report))
    : humanImport(product.report, input.displayOut ?? input.out, data.length);
};
