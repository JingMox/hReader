// 这层管：undo 编排（取最近快照 → 校验内容哈希 → 原子还原 → 删快照）；不解释内容、不裁剪历史。

import { join } from "node:path";

import { HrError } from "../hr-error";
import { writeAtomic } from "./atomic";
import { readBytes } from "./bytes";
import type { PatchOptions, PatchTargetInput, UndoResult } from "./contracts";
import { sha256Hex } from "./digest";
import { unlinkOf } from "./fs-ops";
import { latestOf, listSnapshots } from "./history";
import { runLocked } from "./lock";
import { historyDirOf, resolveTarget, type ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

const restore = async (target: ResolvedTarget, deps: PatchDeps): Promise<UndoResult> => {
  const historyDir = historyDirOf(target);
  const latest = latestOf(await listSnapshots(deps, historyDir));
  if (latest === undefined) {
    throw new HrError("undo_unavailable", `没有可回滚的历史快照：${target.relative}`);
  }
  const snapshotPath = join(historyDir, latest.name);
  const bytes = await readBytes(deps.fs, snapshotPath);
  const sha256 = sha256Hex(bytes);
  // 哈希不符 = 快照被截断/改写：拒绝写回，且不消费这份快照（否则真历史也一起丢了）。
  if (!sha256.startsWith(latest.hash)) {
    throw new HrError("io_failure", `快照内容与文件名哈希不符，拒绝写回：${snapshotPath}`);
  }
  await writeAtomic({ path: target.realPath, workspace: target.workspace, data: bytes }, deps);
  await unlinkOf(deps.fs, snapshotPath);
  return { path: target.realPath, bytes: bytes.length, restoredFrom: snapshotPath, sha256 };
};

/** 快照是"写前字节"，所以 undo 一步退回到上一次成功写入之前的状态。 */
export const undoPatch = async (
  input: PatchTargetInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<UndoResult> => {
  const target = await resolveTarget(input, deps.fs);
  return runLocked(target, deps, options, () => restore(target, deps));
};
