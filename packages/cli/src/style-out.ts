// 这层管：`--out` 的落点是否落在风格发现链里（纯路径比较，不碰 fs）；提示而非报错——写别处是合法用法。

import { join } from "node:path";

import { projectStylePath, STYLE_FILE, userStyleDir } from "@hreader/core";
import type { StyleDeps } from "@hreader/core";

import { realpathThroughAncestors } from "./canonical";

/**
 * 发现链只有两条（`packages/core/src/style/load.ts` 的 `resolveStyle`）：项目级
 * `<projectRoot>/.hreader/style.yaml` 与用户级 `<home>/.hreader/styles/<id>/style.yaml`。
 * 路径常量从 core 借用：抄一份字面量迟早与解析链分叉。
 */
export const isDiscoveredStylePath = (path: string, id: string, deps: StyleDeps): boolean => {
  const target = realpathThroughAncestors(path);
  return (
    target === realpathThroughAncestors(projectStylePath(deps)) ||
    target === realpathThroughAncestors(join(userStyleDir(id, deps), STYLE_FILE))
  );
};

/** 提示文案：不报错，只把"怎么写才接得上"说清楚。 */
export const undiscoveredHint = (path: string, id: string, deps: StyleDeps): string =>
  `提示：${path} 不在风格发现路径里；要让 --tone ${id} 找到它，请写到 ${projectStylePath(deps)} 或 ${join(userStyleDir(id, deps), STYLE_FILE)}\n`;
