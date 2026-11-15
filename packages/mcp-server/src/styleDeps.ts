// 这层管：本包唯一一份 `StyleDeps`——三条出口（工具 / 资源 / prompt）都从这里取，不各自拼；
// 以及"主题资源到底在不在"的唯一判定（哨兵文件 + 一条给人看的 WARNING 文案）。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HrError, nodeStyleDeps } from "@hreader/core";
import type { StyleDeps } from "@hreader/core";

/**
 * 内置主题在 `<repo>/styles/<id>/theme.css`。core 的 `nodeStyleDeps` 按**它自己模块**的 URL 往上四层
 * 推仓库根（`packages/core/src/style/node.ts:14`），源码布局下成立；本包被 esbuild 打成 `dist/main.js`
 * 之后 `import.meta.url` 落进 `packages/mcp-server/dist/`，同样的相对深度指向 `<仓库父目录>/styles/`
 * ——内置预设的 `theme.css` 一个都找不到（G3 P0-2 实测：`hr_apply_style` 全部 `unknown_style`）。
 * 所以这里按**本文件**的位置重算：`src/` 与 `dist/` 都在 `packages/mcp-server/` 下一层，
 * `../../../styles/` 两种布局都落在仓库根，再把它显式传给 core（core 侧一行不改）。
 *
 * 但产物被拷到仓库之外时这个相对路径同样落空（包没随附主题资源）。那时**不许**让 core 报
 * `unknown_style`——风格是存在的，是资源没定位到；错归因比报错更贵。
 *
 * 发布布局改这里时，必须同时看 `packages/core/src/style/node.ts:14` 的那句"发布时需把 styles/ 拷进包内
 * 再改这里"——两处都是"仓库根在哪"的约定，只改一处就会像 `L-21` 那样在仓库外失效。
 *
 * 错误码选 `style_io_failure` 而不是新码：错误码是宿主用来分流的契约，一个只为"我们打包打错了"
 * 存在的码，会把构建缺陷永久写进对外接口——宿主拿到它既不能重试也不能改参数，只能读文案。
 * `style_io_failure` 的原意"主题资源定位/读取失败"恰好是事实。
 */
const STYLES_ROOT = fileURLToPath(new URL("../../../styles/", import.meta.url));

/** 哨兵：拿一个真实预设的真实文件当证据——空目录不能让 `existsSync(stylesRoot)` 蒙混过关。 */
const SENTINEL_VISUAL_ID = "atelier-editorial";
const THEME_FILE = "theme.css";

const themesAbsentOf = (stylesRoot: string): boolean =>
  !existsSync(join(stylesRoot, SENTINEL_VISUAL_ID, THEME_FILE));

/**
 * `stylesRootOverride` 只为让"资源缺失"这条错误码可测；正常调用一律不传。
 * 检查放在**真用时**（不落模块顶层）：import 本文件不该因为布局问题就炸。
 */
export const styleDepsOf = (workspace: string, stylesRootOverride?: string): StyleDeps => {
  const stylesRoot = stylesRootOverride ?? STYLES_ROOT;
  if (themesAbsentOf(stylesRoot)) {
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

/** 启动时给宿主的一条 WARNING；资源齐（仓库内布局）时返回 `undefined`，一个字都不打。 */
export const styleRootWarningOf = (stylesRootOverride?: string): string | undefined => {
  const stylesRoot = stylesRootOverride ?? STYLES_ROOT;
  return themesAbsentOf(stylesRoot)
    ? `WARNING 主题资源缺失：${stylesRoot}；hr_apply_style 将不可用`
    : undefined;
};
