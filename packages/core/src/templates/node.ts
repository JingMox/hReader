// This layer: templates 的默认依赖（node fs + 真实 HOME）；与 `style/node.ts` 同口径。

import { homedir } from "node:os";

import { nodePatchDeps } from "../io/node-fs";
import type { TemplateDeps } from "./contracts";

/** 用户级模板根取 `<homedir()>/.hreader/templates`；测试用临时 home 注入，绝不碰真实 HOME。 */
export const nodeTemplateDeps = (): TemplateDeps => ({
  ...nodePatchDeps,
  home: homedir(),
});
