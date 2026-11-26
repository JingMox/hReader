// 这层管：视觉维度的主题定位与读取（内置仓库 `styles/` 为主，用户目录可覆盖）；不做 HTML 变换。

import { join } from "node:path";

import { HrError } from "../hr-error";
import { assertThemeSafe } from "./css";
import type { StyleDeps } from "./contracts";
import { assertStyleId } from "./id";
import {
  builtinThemeDir,
  existsOf,
  readOptionalText,
  styleIo,
  THEME_FILE,
  userThemePath,
} from "./resource";

/** 用户目录优先、仓库内置兜底：与语言维度的"就近覆盖"同一口径。 */
const themeCandidates = (visualId: string, deps: StyleDeps): readonly string[] => [
  userThemePath(visualId, deps),
  join(builtinThemeDir(visualId, deps), THEME_FILE),
];

export const resolveThemePath = async (visualId: string, deps: StyleDeps): Promise<string> => {
  assertStyleId(visualId);
  for (const path of themeCandidates(visualId, deps)) {
    if (await existsOf(path, deps)) return path;
  }
  throw new HrError(
    "unknown_style",
    `找不到视觉主题：${visualId}（已查用户 ~/.hreader/styles 与仓库 styles/）`,
  );
};

/** 注入前先过静态防线：主题只能离线自足。 */
export const readThemeCss = async (path: string, deps: StyleDeps): Promise<string> => {
  const css = await readOptionalText(path, deps);
  if (css === undefined) throw styleIo("读取主题", path, undefined);
  assertThemeSafe(css);
  return css;
};

/** 主题 id → CSS：`applyStyle` 不走这条（它拿 `resolveStyle` 定下的 `themePath`）。 */
export const loadThemeCss = async (visualId: string, deps: StyleDeps): Promise<string> =>
  readThemeCss(await resolveThemePath(visualId, deps), deps);
