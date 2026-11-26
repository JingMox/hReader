// 这层管：`hr new`（按文档形态起稿 + 套主题 → 原子写）；不判参数、不定退出码。
// `<file>` 的落盘规矩与 `hr export --out` 同一套（父目录 → 越界 → 已存在），不另写第二份判定。

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
  /** 绝对路径（分发层已换成真实路径）。 */
  readonly path: string;
  readonly docKind: DocKind;
  readonly title: string;
  readonly visual: string;
  readonly workspace: string;
  readonly force: boolean;
  readonly json: boolean;
  /** 回执里印的路径（用户视角）：不给就印真实路径。 */
  readonly displayPath?: string | undefined;
}

export const newDocCommand = async (input: NewDocInput): Promise<string> => {
  // 主题先取：未知主题在写盘前就失败，不留一份没套样式的半成品。
  const css = await loadThemeCss(input.visual, nodeStyleDeps(input.workspace));
  const skeleton = newDocumentHtml({ kind: input.docKind, title: input.title });
  const data = encoder.encode(replaceTheme(skeleton, css).html);
  // 顺序与 `hr export --out` 一致：io（父目录）→ 越界 → 已存在，退出码才稳定是 3/3/1。
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
