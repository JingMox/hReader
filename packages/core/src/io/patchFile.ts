// 这层管：patch 落盘编排（路径校验 → 锁 → 备份 → 原子写 → 裁剪）；不做 HTML 变换。

import { applyPatch } from "../ops/patchNode";
import { writeAtomic } from "./atomic";
import { decodeUtf8, encodeUtf8, readBytes } from "./bytes";
import type { PatchFileInput, PatchOptions, PatchResult } from "./contracts";
import { latestOf, listSnapshots, pruneSnapshots, writeSnapshot } from "./history";
import { runLocked } from "./lock";
import { historyDirOf, resolveTarget, type ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

/**
 * 写前先备份、写后再裁剪：中途失败时"多一份历史"是可接受的，少一份则 undo 丢数据。
 * 全部校验（含片段）都在写之前完成——校验失败时原文件字节不变。
 */
const applyToFile = async (
  target: ResolvedTarget,
  request: PatchFileInput["request"],
  deps: PatchDeps,
): Promise<PatchResult> => {
  const historyDir = historyDirOf(target);
  const original = await readBytes(deps.fs, target.realPath);
  // 只解码、不做 BOM 归一：BOM 由源码区间原样带过去，写回时不会再额外拼一份（v2#5）。
  const outcome = applyPatch(decodeUtf8(original, target.realPath), request);
  if (!outcome.changed) {
    const undoable = latestOf(await listSnapshots(deps, historyDir)) !== undefined;
    return {
      path: target.realPath,
      bytes: original.length,
      newIds: [],
      replacedIds: [],
      warnings: outcome.warnings,
      historyPath: null,
      changed: false,
      undoable,
    };
  }
  const historyPath = await writeSnapshot(
    { dir: historyDir, workspace: target.workspace, data: original },
    deps,
  );
  const bytes = encodeUtf8(outcome.html);
  await writeAtomic({ path: target.realPath, workspace: target.workspace, data: bytes }, deps);
  await pruneSnapshots(deps, historyDir);
  return {
    path: target.realPath,
    bytes: bytes.length,
    newIds: outcome.newIds,
    replacedIds: outcome.replacedIds,
    warnings: outcome.warnings,
    historyPath,
    changed: true,
    undoable: true,
  };
};

export const patchFile = async (
  input: PatchFileInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<PatchResult> => {
  const target = await resolveTarget({ workspace: input.workspace, file: input.file }, deps.fs);
  return runLocked(target, deps, options, () => applyToFile(target, input.request, deps));
};
