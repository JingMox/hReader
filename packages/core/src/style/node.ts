// 这层管：风格引擎的默认依赖（仓库内置 `styles/` 根 + HOME + 项目根）；不含业务规则。

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { nodePatchDeps } from "../io/node-fs";
import type { StyleDeps } from "./contracts";

/**
 * `packages/core/src/style/` 往上四层即仓库根：内置主题在 `<repo>/styles/<id>/theme.css`。
 * 注意：作为 npm 依赖安装后这条相对路径会落到**使用者**的目录树（G2 P2-8）；M1 不从 npm 消费，
 * 将来发布时需把 `styles/` 拷进包内再改这里。
 */
const REPO_STYLES = fileURLToPath(new URL("../../../../styles/", import.meta.url));

export const nodeStyleDeps = (projectRoot: string): StyleDeps => ({
  ...nodePatchDeps,
  home: homedir(),
  projectRoot,
  stylesRoot: REPO_STYLES,
});
