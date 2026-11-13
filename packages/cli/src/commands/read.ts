// 这层管：`hr read`（读文件 → 注入 ID → 读节点 → HTML/JSON）；不做参数校验。

import { injectNodeIds, parseHtml, readNode } from "@hreader/core";

import { readTextFile } from "../input";
import { dataRead, humanRead, jsonOk } from "../output";

export interface ReadInput {
  readonly path: string;
  readonly target: string;
  readonly maxBytes: number | undefined;
  readonly json: boolean;
}

export const readCommand = async (input: ReadInput): Promise<string> => {
  const injected = injectNodeIds(parseHtml(await readTextFile(input.path)));
  const result =
    input.maxBytes === undefined
      ? readNode(injected.parsed, input.target)
      : readNode(injected.parsed, input.target, input.maxBytes);
  return input.json ? jsonOk(dataRead(result, injected.injected)) : humanRead(result);
};
