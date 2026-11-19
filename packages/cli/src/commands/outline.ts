// 这层管：`hr outline`（读文件 → 前置检查 → 解析 → 大纲 → 文本/JSON）；不做参数校验、不判断退出码。
// 诊断在两种模式下都看得见：`--json` 在信封里，人读模式走 `warn`（SKILL.md：没 id 的标题以 warning 出现在 stderr）。

import { buildOutline, parseHtml } from "@hreader/core";

import { assertIsDocument, assertNormalized } from "../document-normalize";
import { readTextFile } from "../input";
import { dataOutline, humanDiagnostic, humanOutline, jsonOk } from "../output";

export interface OutlineInput {
  readonly path: string;
  readonly json: boolean;
  /** 诊断出口（人读模式）；缺省 = 丢弃（单测只需要返回串时）。 */
  readonly warn?: (message: string) => void;
}

export const outlineCommand = async (input: OutlineInput): Promise<string> => {
  const parsed = parseHtml(await readTextFile(input.path));
  assertIsDocument(parsed, input.path);
  assertNormalized(parsed, input.path);
  const outline = buildOutline(parsed);
  if (input.json) return jsonOk(dataOutline(outline));
  for (const diagnostic of outline.diagnostics) input.warn?.(humanDiagnostic(diagnostic));
  return humanOutline(outline);
};
