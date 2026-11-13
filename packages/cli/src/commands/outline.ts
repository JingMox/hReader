// 这层管：`hr outline`（读文件 → 解析 → 大纲 → 文本/JSON）；不做参数校验、不判断退出码。

import { buildOutline, parseHtml } from "@hreader/core";

import { readTextFile } from "../input";
import { dataOutline, humanOutline, jsonOk } from "../output";

export interface OutlineInput {
  readonly path: string;
  readonly json: boolean;
}

export const outlineCommand = async (input: OutlineInput): Promise<string> => {
  const outline = buildOutline(parseHtml(await readTextFile(input.path)));
  return input.json ? jsonOk(dataOutline(outline)) : humanOutline(outline);
};
