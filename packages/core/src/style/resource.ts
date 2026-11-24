// 这层管：风格资源的位置与读取（`style.yaml`/`theme.css` 的探路 + 错误码映射）；不解析内容。

import { join } from "node:path";

import { HrError } from "../hr-error";
import { decodeUtf8 } from "../io/bytes";
import { isMissing } from "../io/errors";
import type { StyleDeps } from "./contracts";

export const STYLE_FILE = "style.yaml";

export const THEME_FILE = "theme.css";

/** 与 `io/paths.ts` 的 `STORE_DIR` 同值：hreader 的存储根在两处都必须一致。 */
const PROJECT_DIR = ".hreader";

const USER_STYLES = "styles";

/** 风格资源读不了 ≠ 文档读不了：给独立码，调用方才能提示"你的风格文件坏了"。 */
export const styleIo = (action: string, path: string, error: unknown): HrError =>
  new HrError("style_io_failure", `${action}失败：${path}`, { cause: error });

export const projectStylePath = (deps: StyleDeps): string =>
  join(deps.projectRoot, PROJECT_DIR, STYLE_FILE);

export const userStyleDir = (id: string, deps: StyleDeps): string =>
  join(deps.home, PROJECT_DIR, USER_STYLES, id);

export const userStylesRoot = (deps: StyleDeps): string =>
  join(deps.home, PROJECT_DIR, USER_STYLES);

export const userThemePath = (id: string, deps: StyleDeps): string =>
  join(userStyleDir(id, deps), THEME_FILE);

export const builtinThemeDir = (id: string, deps: StyleDeps): string => join(deps.stylesRoot, id);

/** 缺文件返回 `undefined`（"这一级没有"是正常路径），其余一律 `style_io_failure`。 */
export const readOptionalText = async (
  path: string,
  deps: StyleDeps,
): Promise<string | undefined> => {
  try {
    return decodeUtf8(await deps.fs.readFile(path), path);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw styleIo("读取风格资源", path, error);
  }
};

/** 缺文件 = `false`（"这一级没有"是正常路径）；其余异常一律 `style_io_failure`。 */
export const existsOf = async (path: string, deps: StyleDeps): Promise<boolean> => {
  try {
    await deps.fs.lstat(path);
    return true;
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw styleIo("探测风格资源", path, error);
  }
};

/** 目录不存在 = 空集合；`readdir` 的真故障仍要冒泡成 `style_io_failure`。 */
export const listDirsOrEmpty = async (dir: string, deps: StyleDeps): Promise<readonly string[]> => {
  try {
    return await deps.fs.readdir(dir);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw styleIo("读风格目录", dir, error);
  }
};
