// 这层管：`hr_apply_style` 的落盘编排（读主题 → 锁 → 只换 style 块 → 原子写）；不做 CSS 生成。

import { writeAtomic } from "../io/atomic";
import { decodeUtf8, encodeUtf8, readBytes } from "../io/bytes";
import type { PatchOptions } from "../io/contracts";
import { runLocked } from "../io/lock";
import { resolveTarget, type ResolvedTarget } from "../io/paths";
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
  const bytes = encodeUtf8(outcome.html);
  await writeAtomic({ path: target.realPath, workspace: target.workspace, data: bytes }, deps);
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
