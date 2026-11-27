// This layer: the package's single `StyleDeps` — all three exits (tool / resource / prompt) take it from here instead of each building one;
// plus the single verdict on "are the theme resources actually there" (sentinel file + one human WARNING line).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HrError, nodeStyleDeps } from "@hreader/core";
import type { StyleDeps } from "@hreader/core";

/**
 * The theme resources shipped inside the package (**a different fact**, not a second spelling of the in-repo tree): `build` copies `packages/core/themes/`
 * into `<pkg>/styles`, and both `src/style-deps.ts` and `dist/main.js` happen to sit one level below the package root, so `../styles/`
 * points at `<pkg>/styles` in both the source layout and the published layout.
 *
 * The in-repo fallback is computed **only** by core: `nodeStyleDeps(workspace).stylesRoot` in `packages/core/src/style/node.ts`.
 * That comment says "when publishing, copy styles/ into the package and update here" — this file is that "inside the package"; the two sides must find each other,
 * or a release would change only one.
 */
const PACKAGE_STYLES_ROOT = fileURLToPath(new URL("../styles/", import.meta.url));

/** Sentinel: use a real file of a real preset as proof — an empty directory must not let `existsSync(stylesRoot)` pass. */
const SENTINEL_VISUAL_ID = "atelier-editorial";
const THEME_FILE = "theme.css";

const themesAbsentOf = (stylesRoot: string): boolean =>
  !existsSync(join(stylesRoot, SENTINEL_VISUAL_ID, THEME_FILE));

/** Candidate order is hardcoded "package-local first": in a release the package copy is the source of truth; the repo root only covers running from source (unbuilt). */
export const styleCandidatesOf = (workspace: string): readonly string[] => [
  PACKAGE_STYLES_ROOT,
  nodeStyleDeps(workspace).stylesRoot,
];

/** The first candidate that actually holds theme resources; `undefined` when none does ("is it there" only asks the sentinel file). */
export const firstThemeRootOf = (candidates: readonly string[]): string | undefined =>
  candidates.find((root) => !themesAbsentOf(root));

/**
 * `stylesRootOverride` exists only to make the "resources missing" error code testable; normal callers never pass it (when passed it is the only candidate).
 * The check runs **at actual use** (not at module top level): importing this file must not blow up over a layout problem.
 */
const candidatesOf = (workspace: string, stylesRootOverride?: string): readonly string[] =>
  stylesRootOverride === undefined ? styleCandidatesOf(workspace) : [stylesRootOverride];

const stylesRootOf = (workspace: string, stylesRootOverride?: string): string | undefined =>
  firstThemeRootOf(candidatesOf(workspace, stylesRootOverride));

/**
 * When no resources can be located we must **not** let core report `unknown_style` — the style exists; its resources were not found;
 * misattribution costs more than an error. The code is `style_io_failure`, not a new one: error codes are the contract the host routes on,
 * and a code that only exists for "we packaged it wrong" would etch a build defect into the public interface forever.
 */
export const styleDepsOf = (workspace: string, stylesRootOverride?: string): StyleDeps => {
  const stylesRoot = stylesRootOf(workspace, stylesRootOverride);
  if (stylesRoot === undefined) {
    throw new HrError(
      "style_io_failure",
      // The body only gives the package-relative location: absolute paths belong to host layout and only appear in the stderr WARNING.
      `主题资源不可用：styles/${SENTINEL_VISUAL_ID}/${THEME_FILE} 不存在` +
        "（预设 id 需要 styles/ 目录随包发布）。若你是从仓库内运行，说明 styles/ 未随产物一同定位；" +
        "若你装的是发布版，请报告该包缺少主题资源。",
    );
  }
  return { ...nodeStyleDeps(workspace), stylesRoot };
};

/** One WARNING line for the host at startup; returns `undefined` when resources are all present — prints nothing at all. */
export const styleRootWarningOf = (
  workspace: string,
  stylesRootOverride?: string,
): string | undefined => {
  const candidates = candidatesOf(workspace, stylesRootOverride);
  return firstThemeRootOf(candidates) === undefined
    ? `WARNING 主题资源缺失：${candidates.join("、")}；hr_apply_style 将不可用`
    : undefined;
};
