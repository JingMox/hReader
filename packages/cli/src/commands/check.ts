// 这层管：`hr check`（文档级诊断 + 排版约束检查 + 外来 HTML 分档）→ 文本/JSON；
// 只读，不改文档；`--strict` 的「先出报告再失败」靠 StrictFailure 把报告带回分发层。

import { checkLayout, classifyDocument, parseHtml, validateDocument } from "@hreader/core";

import type { StrictLevel } from "../args";
import { StrictFailure } from "../errors";
import { readTextFile } from "../input";
import { dataCheck, humanCheck, jsonOk } from "../output";

export interface CheckInput {
  readonly path: string;
  readonly json: boolean;
  readonly strict?: StrictLevel | undefined;
  /** 汇总行里印的路径（用户视角）：不给就印 `path`。 */
  readonly displayPath?: string | undefined;
}

/**
 * 不做 `needs_normalize` 前置：检查不消耗 id，缺 id 的文档照样能查排版；
 * “没有 `<article>`”也不单独报错，它本来就是 `validateDocument` 的一条诊断。
 */
export const checkCommand = async (input: CheckInput): Promise<string> => {
  const parsed = parseHtml(await readTextFile(input.path));
  const issues = [...validateDocument(parsed), ...checkLayout(parsed.root)];
  const classification = classifyDocument(parsed);
  const path = input.displayPath ?? input.path;
  const output = input.json
    ? jsonOk(dataCheck(issues, classification.cls, classification.reason))
    : humanCheck(issues, path, classification.cls === "foreign");
  if (input.strict === undefined) return output;
  const hits = issues.filter((issue) => input.strict === "warning" || issue.severity === "error");
  if (hits.length === 0) return output;
  const level = input.strict === "warning" ? "" : " error 级";
  throw new StrictFailure(`${path}：${String(hits.length)} 条${level}诊断（--strict）`, output);
};
