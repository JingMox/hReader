// 这层管：`hr check`（文档级诊断 + 排版约束检查）→ 文本/JSON；只读，不改文档、不判断退出码。

import { checkLayout, parseHtml, validateDocument } from "@hreader/core";

import { readTextFile } from "../input";
import { dataCheck, humanCheck, jsonOk } from "../output";

export interface CheckInput {
  readonly path: string;
  readonly json: boolean;
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
  return input.json
    ? jsonOk(dataCheck(issues))
    : humanCheck(issues, input.displayPath ?? input.path);
};
