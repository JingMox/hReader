// 这层管：一键撤销（AC2.3/AC3.3）——复用 patch 的同一条快照链，只把"没有历史"翻成对外码。
// 不复制 undo 逻辑：`undoPatch` 已经是"取最近快照 → 校验哈希 → 原子还原 → 删快照"的唯一定义。

import { HrError } from "../hr-error";
import type { PatchOptions, PatchTargetInput, UndoResult } from "../io/contracts";
import type { PatchDeps } from "../io/ports";
import { undoPatch } from "../io/undo";

export interface RevertResult extends UndoResult {
  /** 与 `undo` 的返回同义：还原后的内容哈希，供 SSE/前端对齐 revision。 */
  readonly revision: string;
}

const asNothingToUndo = (error: unknown): unknown => {
  if (error instanceof HrError && error.code === "undo_unavailable") {
    return new HrError("nothing_to_undo", "没有可撤销的历史快照", { cause: error });
  }
  return error;
};

/** 撤销最近一次写（patch / style / 批注共用同一条链）。 */
export const revertLast = async (
  input: PatchTargetInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<RevertResult> => {
  try {
    const result = await undoPatch(input, deps, options);
    return { ...result, revision: result.sha256.slice(0, 16) };
  } catch (error: unknown) {
    throw asNothingToUndo(error);
  }
};
