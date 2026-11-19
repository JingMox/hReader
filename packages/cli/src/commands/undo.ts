// 这层管：`hr undo`（把文件恢复到最近一份历史快照）→ 文本/JSON；不解析参数、不读 stdin。
// 用 `revertLast` 而不是 `undoPatch`：“没有历史”翻成对外的 `nothing_to_undo` 只有一份定义（M3.4）。

import { nodePatchDeps, revertLast } from "@hreader/core";

import { dataUndo, humanUndo } from "../output";

export interface UndoInput {
  readonly path: string;
  readonly workspace: string;
  readonly json: boolean;
  /** 回执里印的路径（用户视角）：不给就印结果里的真实路径。 */
  readonly displayPath?: string | undefined;
}

export const undoCommand = async (input: UndoInput): Promise<string> => {
  const result = await revertLast({ workspace: input.workspace, file: input.path }, nodePatchDeps);
  return input.json ? dataUndo(result) : humanUndo(result, input.displayPath ?? result.path);
};
