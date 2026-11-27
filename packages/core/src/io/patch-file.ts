// 这层管：patch 落盘编排（路径校验 → 锁 → 备份 → 原子写 → 裁剪）；不做 HTML 变换。

import { applyPatch, type PatchOutcome } from "../ops/patch-node";
import { writeAtomic } from "./atomic";
import { decodeUtf8, encodeUtf8, readBytes } from "./bytes";
import type { PatchFileInput, PatchOptions, PatchResult, PatchTargetInput } from "./contracts";
import { latestOf, listSnapshots, pruneSnapshots, writeSnapshot } from "./history";
import { runLocked } from "./lock";
import { historyDirOf, resolveTarget, type ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

/** 在锁内、在**这份字节**上求写回结果：定位只对要写回的那棵树成立，不能分两次读。 */
type PatchOutcomeOf<O extends PatchOutcome> = (html: string) => O;

/**
 * 读与求值必须共用同一份字节：`original` 与 `outcome` 只能由同一处产出，
 * 不能分两次读、也不能只把 html 传下去。
 */
const readAndApply = async <O extends PatchOutcome>(
  target: ResolvedTarget,
  outcomeOf: PatchOutcomeOf<O>,
  deps: PatchDeps,
): Promise<{ original: Uint8Array; outcome: O }> => {
  const original = await readBytes(deps.fs, target.realPath);
  // 只解码、不做 BOM 归一：BOM 由源码区间原样带过去，写回时不会再额外拼一份。
  const html = decodeUtf8(original, target.realPath);
  return { original, outcome: outcomeOf(html) };
};

/**
 * 写前先备份、写后再裁剪：中途失败时"多一份历史"是可接受的，少一份则 undo 丢数据。
 * 全部校验（含片段）都在写之前完成——校验失败时原文件字节不变。
 */
const applyToFile = async <O extends PatchOutcome>(
  target: ResolvedTarget,
  outcomeOf: PatchOutcomeOf<O>,
  deps: PatchDeps,
): Promise<{ result: PatchResult; outcome: O }> => {
  const historyDir = historyDirOf(target);
  const { original, outcome } = await readAndApply(target, outcomeOf, deps);
  if (!outcome.changed) {
    const undoable = latestOf(await listSnapshots(deps, historyDir)) !== undefined;
    return {
      result: {
        path: target.realPath,
        bytes: original.length,
        newIds: [],
        replacedIds: [],
        warnings: outcome.warnings,
        historyPath: null,
        changed: false,
        undoable,
      },
      outcome,
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
    result: {
      path: target.realPath,
      bytes: bytes.length,
      newIds: outcome.newIds,
      replacedIds: outcome.replacedIds,
      warnings: outcome.warnings,
      historyPath,
      changed: true,
      undoable: true,
    },
    outcome,
  };
};

/**
 * 同一个落盘编排（路径校验 → 锁 → 备份 → 原子写 → 裁剪），但变换由调用方给：
 * `patchFile` 用它跑托管文档的 `applyPatch`，`patchBlock` 用它跑块地址的 `applyBlockPatch`。
 * outcome 一并回给调用方——非托管写入要带额外字段（新块地址），只有它拿得到。
 */
export const patchFileOutcome = async <O extends PatchOutcome>(
  input: PatchTargetInput,
  deps: PatchDeps,
  options: PatchOptions,
  outcomeOf: PatchOutcomeOf<O>,
): Promise<{ result: PatchResult; outcome: O }> => {
  const target = await resolveTarget({ workspace: input.workspace, file: input.file }, deps.fs);
  return runLocked(target, deps, options, () => applyToFile(target, outcomeOf, deps));
};

export const patchFile = async (
  input: PatchFileInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<PatchResult> => {
  const requestOf = input.request;
  // 函数形式的 request 在锁内、在**这份字节**上才求值：它的定位结果必须属于要写的那棵树。
  const { result } = await patchFileOutcome(input, deps, options, (html) =>
    applyPatch(html, typeof requestOf === "function" ? requestOf(html) : requestOf),
  );
  return result;
};
