// 这层管：`hr_apply_style` 的落盘编排（读主题 → 锁 → 只换 style 块 → 原子写）；不做 CSS 生成。

import { writeAtomic } from "../io/atomic";
import { decodeUtf8, encodeUtf8, readBytes } from "../io/bytes";
import type { PatchOptions } from "../io/contracts";
import { pruneSnapshots, writeSnapshot } from "../io/history";
import { runLocked } from "../io/lock";
import { historyDirOf, resolveTarget, type ResolvedTarget } from "../io/paths";
import { replaceTheme } from "./apply";
import type { ApplyStyleInput, ApplyStyleResult, StyleDeps } from "./contracts";
import { resolveStyle } from "./load";
import { readThemeCss } from "./theme";

const applyToFile = async (
  target: ResolvedTarget,
  css: string,
  deps: StyleDeps,
): Promise<ApplyStyleResult> => {
  const original = await readBytes(deps.fs, target.realPath);
  const outcome = replaceTheme(decodeUtf8(original, target.realPath), css);
  if (!outcome.changed) {
    return { path: target.realPath, bytes: original.length, changed: false };
  }
  // 与 patch 同一条链：写前快照、写后裁剪，样式应用也能被 undo 退回。
  const historyDir = historyDirOf(target);
  await writeSnapshot({ dir: historyDir, workspace: target.workspace, data: original }, deps);
  const bytes = encodeUtf8(outcome.html);
  await writeAtomic({ path: target.realPath, workspace: target.workspace, data: bytes }, deps);
  await pruneSnapshots(deps, historyDir);
  return { path: target.realPath, bytes: bytes.length, changed: true };
};

/** 复用 patch 的锁与原子写：不新增写入路径，失败时不留 tmp。 */
export const applyStyle = async (
  input: ApplyStyleInput,
  deps: StyleDeps,
  options: PatchOptions = {},
): Promise<ApplyStyleResult> => {
  const style = await resolveStyle({ id: input.visualId }, deps);
  const css = await readThemeCss(style.themePath, deps);
  const target = await resolveTarget({ workspace: input.workspace, file: input.file }, deps.fs);
  return runLocked(target, deps, options, () => applyToFile(target, css, deps));
};
