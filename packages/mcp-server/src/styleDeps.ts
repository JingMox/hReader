// 这层管：本包唯一一份 `StyleDeps`——三条出口（工具 / 资源 / prompt）都从这里取，不各自拼；
// 以及"主题资源到底在不在"的唯一判定（哨兵文件 + 一条给人看的 WARNING 文案）。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HrError, nodeStyleDeps } from "@hreader/core";
import type { StyleDeps } from "@hreader/core";

/**
 * 包内自带的主题资源（**不同的事实**，不是仓库根的第二份拼写）：`build` 把仓库根 `styles/` 整棵拷成
 * `<pkg>/styles`，而 `src/styleDeps.ts` 与 `dist/main.js` 都恰好比包根深一层，所以 `../styles/`
 * 在源码布局和发布布局里都指向 `<pkg>/styles`（M3.1.1 §2 的锚点推导）。
 *
 * 仓库根在哪**只**由 core 拼：`packages/core/src/style/node.ts:14` 的 `nodeStyleDeps(workspace).stylesRoot`。
 * 那边注释写着"发布时需把 styles/ 拷进包内再改这里"——本文件就是那个"包内"，两边要能互相找到，
 * 否则发布时只会改一处（`L-21`）。
 */
const PACKAGE_STYLES_ROOT = fileURLToPath(new URL("../styles/", import.meta.url));

/** 哨兵：拿一个真实预设的真实文件当证据——空目录不能让 `existsSync(stylesRoot)` 蒙混过关。 */
const SENTINEL_VISUAL_ID = "atelier-editorial";
const THEME_FILE = "theme.css";

const themesAbsentOf = (stylesRoot: string): boolean =>
  !existsSync(join(stylesRoot, SENTINEL_VISUAL_ID, THEME_FILE));

/** 候选顺序写死"包内优先"：发布版里包内那份才是真值源，仓库根只兜底源码直跑（未 build）。 */
export const styleCandidatesOf = (workspace: string): readonly string[] => [
  PACKAGE_STYLES_ROOT,
  nodeStyleDeps(workspace).stylesRoot,
];

/** 第一个真有主题资源的候选；一个都没有就返回 `undefined`（"在不在"只问哨兵文件）。 */
export const firstThemeRootOf = (candidates: readonly string[]): string | undefined =>
  candidates.find((root) => !themesAbsentOf(root));

/**
 * `stylesRootOverride` 只为让"资源缺失"这条错误码可测；正常调用一律不传（传了它就是唯一候选）。
 * 检查放在**真用时**（不落模块顶层）：import 本文件不该因为布局问题就炸。
 */
const candidatesOf = (workspace: string, stylesRootOverride?: string): readonly string[] =>
  stylesRootOverride === undefined ? styleCandidatesOf(workspace) : [stylesRootOverride];

const stylesRootOf = (workspace: string, stylesRootOverride?: string): string | undefined =>
  firstThemeRootOf(candidatesOf(workspace, stylesRootOverride));

/**
 * 资源一个都定位不到时**不许**让 core 报 `unknown_style`——风格是存在的，是资源没定位到；
 * 错归因比报错更贵。错误码选 `style_io_failure` 而不是新码：错误码是宿主用来分流的契约，
 * 一个只为"我们打包打错了"存在的码，会把构建缺陷永久写进对外接口。
 */
export const styleDepsOf = (workspace: string, stylesRootOverride?: string): StyleDeps => {
  const stylesRoot = stylesRootOf(workspace, stylesRootOverride);
  if (stylesRoot === undefined) {
    throw new HrError(
      "style_io_failure",
      // 正文里只给包内相对位置：绝对路径属于宿主布局，只该出现在 stderr 的 WARNING 里。
      `主题资源不可用：styles/${SENTINEL_VISUAL_ID}/${THEME_FILE} 不存在` +
        "（预设 id 需要 styles/ 目录随包发布）。若你是从仓库内运行，说明 styles/ 未随产物一同定位；" +
        "若你装的是发布版，请报告该包缺少主题资源。",
    );
  }
  return { ...nodeStyleDeps(workspace), stylesRoot };
};

/** 启动时给宿主的一条 WARNING；资源齐时返回 `undefined`，一个字都不打。 */
export const styleRootWarningOf = (
  workspace: string,
  stylesRootOverride?: string,
): string | undefined => {
  const candidates = candidatesOf(workspace, stylesRootOverride);
  return firstThemeRootOf(candidates) === undefined
    ? `WARNING 主题资源缺失：${candidates.join("、")}；hr_apply_style 将不可用`
    : undefined;
};
