// 这层管：`hr style` 三种模式（--visual 落盘 / --tone 编译 prompt / --lint 禁用词）；不做参数校验。

import { join } from "node:path";

import {
  DEFAULT_STYLE_ID,
  applyStyle,
  compileTone,
  injectNodeIds,
  lintByStyle,
  loadStyle,
  nodeStyleDeps,
  parseHtml,
  toDocumentModel,
} from "@hreader/core";
import type { LintReport } from "@hreader/core";

import type { StyleMode } from "../args";
import { readTextFile } from "../input";
import { dataLint, dataStyle, dataTone, humanLint, humanStyle, humanTone, jsonOk } from "../output";

export interface StyleInput {
  readonly path: string;
  readonly mode: StyleMode;
  readonly workspace: string;
  readonly json: boolean;
}

/** `--lint` 没有风格参数：用默认风格的禁用词表（卡片 §1 的唯一 id）。 */
const lintReportOf = async (file: string, workspace: string): Promise<LintReport> => {
  const style = await loadStyle({ id: DEFAULT_STYLE_ID }, nodeStyleDeps(workspace));
  const injected = injectNodeIds(parseHtml(await readTextFile(join(workspace, file))));
  return lintByStyle([toDocumentModel(injected.parsed)], style.spec.language.vocabulary);
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
  const result = await applyStyle(
    { workspace: input.workspace, file: input.path, visualId: input.mode.id },
    deps,
  );
  return input.json ? jsonOk(dataStyle(result)) : humanStyle(result);
};
