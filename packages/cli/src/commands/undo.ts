// 这层管：`hr undo`（把文件恢复到最近一份历史快照）→ 文本/JSON；不解析参数、不读 stdin。

import { nodePatchDeps, undoPatch } from "@hreader/core";

import { dataUndo, humanUndo } from "../output";

export interface UndoInput {
  readonly path: string;
  readonly workspace: string;
  readonly json: boolean;
}

export const undoCommand = async (input: UndoInput): Promise<string> => {
  const result = await undoPatch({ workspace: input.workspace, file: input.path }, nodePatchDeps);
  return input.json ? dataUndo(result) : humanUndo(result);
};
