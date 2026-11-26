// This layer: `hr style`'s three modes (--visual writes / --tone compiles a prompt / --lint banned words); only the --visual id space is checked here, args handles the rest.

import { join } from "node:path";

import {
  BUILTIN_STYLES,
  DEFAULT_STYLE_ID,
  HrError,
  applyStyle,
  compileTone,
  discoverStyles,
  injectNodeIds,
  lintByStyle,
  loadStyle,
  nodeStyleDeps,
  parseHtml,
  resolveThemePath,
  toDocumentModel,
} from "@hreader/core";
import type { LintReport, StyleDeps } from "@hreader/core";

import type { StrictLevel, StyleMode } from "../args";
import { StrictFailure } from "../errors";
import { readTextFile } from "../input";
import { dataLint, dataStyle, dataTone, humanLint, humanStyle, humanTone, jsonOk } from "../output";

export interface StyleInput {
  readonly path: string;
  readonly mode: StyleMode;
  readonly workspace: string;
  readonly json: boolean;
  /** Only used by `--lint`: a banned-word hit fails as invalid_document (the report goes to stdout first). */
  readonly strict?: StrictLevel | undefined;
  /** Path printed in the receipt (user's view): falls back to the result's real path when not given. */
  readonly displayPath?: string | undefined;
}

/** `--lint` takes no style argument: it uses the default style's banned-word list (the default style's sole id). */
const lintReportOf = async (file: string, workspace: string): Promise<LintReport> => {
  const style = await loadStyle({ id: DEFAULT_STYLE_ID }, nodeStyleDeps(workspace));
  const injected = injectNodeIds(parseHtml(await readTextFile(join(workspace, file))));
  return lintByStyle([toDocumentModel(injected.parsed)], style.spec.language.vocabulary);
};

/** Whether a visual theme can be loaded: `resolveThemePath` is the single place (user dir first, repo-bundled fallback). */
const hasVisualTheme = async (id: string, deps: StyleDeps): Promise<boolean> => {
  try {
    await resolveThemePath(id, deps);
    return true;
  } catch (error: unknown) {
    if (error instanceof HrError && error.code === "unknown_style") return false;
    throw error;
  }
};

/** Tone registry: built-in presets + project `.hreader/style.yaml` + user styles dir — not a single name is hardcoded. */
const isToneId = async (id: string, deps: StyleDeps): Promise<boolean> => {
  const discovered = await discoverStyles(deps);
  return [...BUILTIN_STYLES, ...discovered.styles].some((style) => style.id === id);
};

/** `--visual` and `--tone` are two id spaces: handing a tone id to `--visual` silently swaps in the wrong theme.
 * An id in neither space is not stopped here: `applyStyle` reports the existing `unknown_style` (not found in any of the four sources). */
const assertVisualId = async (id: string, deps: StyleDeps): Promise<void> => {
  if ((await hasVisualTheme(id, deps)) || !(await isToneId(id, deps))) return;
  throw new HrError(
    "invalid_input",
    `${id} 是 tone（语言基调），请改用 --tone ${id}；--visual 只接受 visual 主题`,
  );
};

export const styleCommand = async (input: StyleInput): Promise<string> => {
  const deps = nodeStyleDeps(input.workspace);
  if (input.mode.kind === "tone") {
    const prompt = compileTone((await loadStyle({ id: input.mode.id }, deps)).spec);
    return input.json ? jsonOk(dataTone(prompt)) : humanTone(prompt);
  }
  if (input.mode.kind === "lint") {
    const report = await lintReportOf(input.path, input.workspace);
    const output = input.json ? jsonOk(dataLint(report)) : humanLint(report);
    // Hits have no error/warning tiering: both `--strict` levels share one threshold — any hit fails.
    if (input.strict !== undefined && report.hits.length > 0) {
      throw new StrictFailure(
        `${input.displayPath ?? input.path}：${String(report.hits.length)} 条禁用词命中（--strict）`,
        output,
      );
    }
    return output;
  }
  await assertVisualId(input.mode.id, deps);
  const result = await applyStyle(
    { workspace: input.workspace, file: input.path, visualId: input.mode.id },
    deps,
  );
  return input.json
    ? jsonOk(dataStyle(result))
    : humanStyle(result, input.displayPath ?? result.path);
};
