// 这层管：风格引擎的默认依赖（内置 `themes/` 根探测 + HOME + 项目根）；不含业务规则。

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nodePatchDeps, nodePathExists } from "../io/node-fs";
import type { StyleDeps } from "./contracts";

const SENTINEL_THEME = join("atelier-editorial", "theme.css");

/**
 * The builtin theme CSS ships inside the package at `packages/core/themes/` — two levels up
 * from `packages/core/src/style/`. Bundled into a single-file CLI (e.g. `dist/cli.mjs`), the
 * sibling `./styles/` and parent `../styles/` copies are probed first; `themes/` is the
 * in-repo fallback.
 */
const REPO_THEMES = fileURLToPath(new URL("../../themes/", import.meta.url));
const STYLES_CANDIDATES: readonly string[] = [
  fileURLToPath(new URL("./styles/", import.meta.url)),
  fileURLToPath(new URL("../styles/", import.meta.url)),
  REPO_THEMES,
];

export const resolveStylesRoot = (
  candidates: readonly string[],
  exists: (path: string) => boolean,
): string => candidates.find((dir) => exists(join(dir, SENTINEL_THEME))) ?? REPO_THEMES;

export const nodeStyleDeps = (projectRoot: string): StyleDeps => ({
  ...nodePatchDeps,
  home: homedir(),
  projectRoot,
  stylesRoot: resolveStylesRoot(STYLES_CANDIDATES, nodePathExists),
});
