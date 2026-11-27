// 这层管：patch 落盘编排（路径校验 → 锁 → 备份 → 原子写 → 裁剪）；不做 HTML 变换。

import { applyPatch, type PatchOutcome } from "../ops/patch-node";
import { writeAtomic } from "./atomic";
import { decodeUtf8, encodeUtf8, readBytes } from "./bytes";
import type { PatchFileInput, PatchOptions, PatchResult, PatchTargetInput } from "./contracts";
import { latestOf, listSnapshots, pruneSnapshots, writeSnapshot } from "./history";
import { runLocked } from "./lock";
import { historyDirOf, resolveTarget, type ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

/** Evaluate the write-back inside the lock on *these* bytes: a locate result only holds for the tree being written, so reading twice is not allowed. */
type PatchOutcomeOf<O extends PatchOutcome> = (html: string) => O;

/**
 * Reading and evaluating must share one set of bytes: `original` and `outcome` may only
 * come from the same read — no second read, and passing only the html down is not enough.
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
 * The same on-disk pipeline (path check → lock → snapshot → atomic write → prune), but the
 * caller supplies the transform: `patchFile` runs managed-document `applyPatch` through it,
 * `patchBlock` runs block-address `applyBlockPatch`. The outcome also goes back to the
 * caller — non-managed writes carry extra fields (the new block address) only it can produce.
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
  // A function request is evaluated inside the lock on *these* bytes: its locate result must belong to the tree being written.
  const { result } = await patchFileOutcome(input, deps, options, (html) =>
    applyPatch(html, typeof requestOf === "function" ? requestOf(html) : requestOf),
  );
  return result;
};
