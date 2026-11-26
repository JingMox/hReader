// 这层管：`hr import`（读外来 HTML → importForeign → 原子写托管文档）；不判参数、不定退出码。
// `<out>` 的落盘规矩与 `hr export --out` 同一套（父目录 → 越界 → 已存在），不另写第二份判定。

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
  /** 外来 HTML 源文件（真实绝对路径）。 */
  readonly path: string;
  /** 落盘位置（真实绝对路径）：意图层已把缺省换成 `<name>.hr.html`。 */
  readonly out: string;
  /** 未给 `--kind` 时为 `undefined`：默认形态归 core，这层不发明默认值。 */
  readonly docKind: DocKind | undefined;
  readonly title: string | undefined;
  readonly workspace: string;
  readonly force: boolean;
  readonly json: boolean;
  /** 回执里印的 `<out>`（用户视角）：不给就印真实路径。 */
  readonly displayOut?: string | undefined;
}

export const importDocCommand = async (input: ImportDocInput): Promise<string> => {
  // 先转换再判写盘：转不出（源已是托管文档）时不探目标路径，也不留半成品。
  const product = importForeign(await readTextFile(input.path), {
    ...(input.docKind === undefined ? {} : { kind: input.docKind }),
    ...(input.title === undefined ? {} : { title: input.title }),
  });
  const data = encoder.encode(product.html);
  // 顺序与 `hr export --out` 一致：io（父目录不可写）→ 越界 → 已存在，退出码才稳定是 3/3/1。
  await assertWritableDirOf(dirname(input.out), nodePatchDeps);
  assertOutInsideOf(input.out, input.workspace);
  await assertTargetFreeOf(input.out, input.force, nodePatchDeps);
  await writeOutOf({ path: input.out, workspace: input.workspace, data, what: "写入导入文档" });
  return input.json
    ? jsonOk(dataImport(input.out, data.length, product.report))
    : humanImport(product.report, input.displayOut ?? input.out, data.length);
};
