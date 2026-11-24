// 这层管：`hr style` 三种模式（--visual 落盘 / --tone 编译 prompt / --lint 禁用词）；只校验 --visual 的 id 空间，其余交给 args。

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

import type { StyleMode } from "../args";
import { readTextFile } from "../input";
import { dataLint, dataStyle, dataTone, humanLint, humanStyle, humanTone, jsonOk } from "../output";

export interface StyleInput {
  readonly path: string;
  readonly mode: StyleMode;
  readonly workspace: string;
  readonly json: boolean;
  /** 回执里印的路径（用户视角）：不给就印结果里的真实路径。 */
  readonly displayPath?: string | undefined;
}

/** `--lint` 没有风格参数：用默认风格的禁用词表（默认风格的唯一 id）。 */
const lintReportOf = async (file: string, workspace: string): Promise<LintReport> => {
  const style = await loadStyle({ id: DEFAULT_STYLE_ID }, nodeStyleDeps(workspace));
  const injected = injectNodeIds(parseHtml(await readTextFile(join(workspace, file))));
  return lintByStyle([toDocumentModel(injected.parsed)], style.spec.language.vocabulary);
};

/** 视觉主题能否加载：`resolveThemePath` 是唯一落点（用户目录优先、仓库内置兜底）。 */
const hasVisualTheme = async (id: string, deps: StyleDeps): Promise<boolean> => {
  try {
    await resolveThemePath(id, deps);
    return true;
  } catch (error: unknown) {
    if (error instanceof HrError && error.code === "unknown_style") return false;
    throw error;
  }
};

/** 语言风格（tone）注册表：内置 preset + 项目 `.hreader/style.yaml` + 用户 styles 目录，一个名字都不硬编码。 */
const isToneId = async (id: string, deps: StyleDeps): Promise<boolean> => {
  const discovered = await discoverStyles(deps);
  return [...BUILTIN_STYLES, ...discovered.styles].some((style) => style.id === id);
};

/** `--visual` 与 `--tone` 是两套 id 空间：把 tone id 交给 `--visual` 会静默换错主题。
 * 既不是 visual 也不是 tone 的 id 不在这里拦：交给 `applyStyle` 报既有的 `unknown_style`（四个来源都找不到）。 */
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
    return input.json ? jsonOk(dataLint(report)) : humanLint(report);
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
