// 这层管：patch 落盘编排（路径校验 → 锁 → 备份 → 原子写 → 裁剪）；不做 HTML 变换。

import { applyPatch, type PatchOutcome } from "../ops/patchNode";
import { writeAtomic } from "./atomic";
import { decodeUtf8, encodeUtf8, readBytes } from "./bytes";
import type { PatchFileInput, PatchOptions, PatchResult } from "./contracts";
import { latestOf, listSnapshots, pruneSnapshots, writeSnapshot } from "./history";
import { runLocked } from "./lock";
import { historyDirOf, resolveTarget, type ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

/**
 * 读与求值必须共用同一份字节：`request` 为函数时它的定位只对要写回的那棵树成立，
 * 因此 `original` 与 `outcome` 只能由同一处产出，不能分两次读、也不能只把 html 传下去。
 */
const readAndApply = async (
  target: ResolvedTarget,
  requestOf: PatchFileInput["request"],
  deps: PatchDeps,
): Promise<{ original: Uint8Array; outcome: PatchOutcome }> => {
  const original = await readBytes(deps.fs, target.realPath);
  // 只解码、不做 BOM 归一：BOM 由源码区间原样带过去，写回时不会再额外拼一份（v2#5）。
  const html = decodeUtf8(original, target.realPath);
  // 函数形式的 request 在锁内、在**这份字节**上才求值：它的定位结果必须属于要写的那棵树。
  const request = typeof requestOf === "function" ? requestOf(html) : requestOf;
  return { original, outcome: applyPatch(html, request) };
};

/**
 * 写前先备份、写后再裁剪：中途失败时"多一份历史"是可接受的，少一份则 undo 丢数据。
 * 全部校验（含片段）都在写之前完成——校验失败时原文件字节不变。
 */
const applyToFile = async (
  target: ResolvedTarget,
  requestOf: PatchFileInput["request"],
  deps: PatchDeps,
): Promise<PatchResult> => {
  const historyDir = historyDirOf(target);
  const { original, outcome } = await readAndApply(target, requestOf, deps);
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
