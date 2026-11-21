// 这层管：风格引擎的默认依赖（内置 `styles/` 根探测 + HOME + 项目根）；不含业务规则。

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nodePatchDeps, nodePathExists } from "../io/node-fs";
import type { StyleDeps } from "./contracts";

const SENTINEL_THEME = join("atelier-editorial", "theme.css");

/**
 * `packages/core/src/style/` 往上四层即仓库根；打包成单文件 CLI（如 `dist/cli.mjs`）后，
 * 优先探测同级 `./styles/` 与上级 `../styles/`，均找不到再落回仓库根 `styles/`。
 */
const REPO_STYLES = fileURLToPath(new URL("../../../../styles/", import.meta.url));
const STYLES_CANDIDATES: readonly string[] = [
  fileURLToPath(new URL("./styles/", import.meta.url)),
  fileURLToPath(new URL("../styles/", import.meta.url)),
  REPO_STYLES,
];

export const resolveStylesRoot = (
  candidates: readonly string[],
  exists: (path: string) => boolean,
): string => candidates.find((dir) => exists(join(dir, SENTINEL_THEME))) ?? REPO_STYLES;

export const nodeStyleDeps = (projectRoot: string): StyleDeps => ({
  ...nodePatchDeps,
  home: homedir(),
  projectRoot,
  stylesRoot: resolveStylesRoot(STYLES_CANDIDATES, nodePathExists),
});
