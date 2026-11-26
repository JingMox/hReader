// This layer: whether an `--out` destination lies on the style-discovery chain (pure path comparison, no fs); a hint, not an error — writing elsewhere is legitimate.

import { join } from "node:path";

import { projectStylePath, STYLE_FILE, userStyleDir } from "@hreader/core";
import type { StyleDeps } from "@hreader/core";

import { realpathThroughAncestors } from "./canonical";
import { term } from "./output";

/**
 * The discovery chain has exactly two links (`resolveStyle` in `packages/core/src/style/load.ts`): the
 * project-level `<projectRoot>/.hreader/style.yaml` and the user-level `<home>/.hreader/styles/<id>/style.yaml`.
 * The path constants are borrowed from core: a copied literal would drift from the resolution chain sooner or later.
 */
export const isDiscoveredStylePath = (path: string, id: string, deps: StyleDeps): boolean => {
  const target = realpathThroughAncestors(path);
  return (
    target === realpathThroughAncestors(projectStylePath(deps)) ||
    target === realpathThroughAncestors(join(userStyleDir(id, deps), STYLE_FILE))
  );
};

/** Hint text: not an error — it only explains how to write the path so discovery picks it up. */
export const undiscoveredHint = (path: string, id: string, deps: StyleDeps): string =>
  term(
    `提示：${path} 不在风格发现路径里；要让 --tone ${id} 找到它，请写到 ${projectStylePath(deps)} 或 ${join(userStyleDir(id, deps), STYLE_FILE)}\n`,
  );
