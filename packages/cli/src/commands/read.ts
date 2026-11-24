// 这层管：`hr read`（读文件 → 读节点 → HTML/JSON）；不做参数校验。
// 不在这里临时补 id：算出来的 id 不在盘上，喂回 `patch` 必挂（缺 id 由 `hr normalize` 补到盘上）。
// 第二位置参数的解释（先选择器、再 node id）在 core 的 `locateTarget` 里，与 `patch` 共用同一处实现。

import { type ParsedHtml, locateTarget, parseHtml, readNode } from "@hreader/core";

import { assertIsDocument, assertNormalized, assertUniqueIds } from "../document-normalize";
import { readTextFile } from "../input";
import { dataRead, humanRead, jsonOk } from "../output";

export interface ReadInput {
  readonly path: string;
  readonly target: string;
  readonly maxBytes: number | undefined;
  readonly json: boolean;
}

const ATTRIBUTE_ID = /data-hr-id="([^"]+)"/gu;

/** `ids` 只列返回 `html` 里真实出现的 id：全文档注入表里其它节点的 id 对调用方是无效引用。 */
const idsOf = (html: string): readonly string[] =>
  [...html.matchAll(ATTRIBUTE_ID)].map((match) => String(match[1]));

/** 缺省上限由 core 给：这里只负责"给了就传、没给就不传"。 */
const readOnce = (
  parsed: ParsedHtml,
  selector: string,
  maxBytes: number | undefined,
): ReturnType<typeof readNode> =>
  maxBytes === undefined ? readNode(parsed, selector) : readNode(parsed, selector, maxBytes);

export const readCommand = async (input: ReadInput): Promise<string> => {
  const parsed = parseHtml(await readTextFile(input.path));
  // 缺 id 的文档不能靠临时注入蒙过去：算出来的 id 不在盘上，喂回 patch 必挂。
  assertIsDocument(parsed, input.path);
  // 重复 id 要排在 `needs_normalize` 前面：那是“缺 id”，这是“两个元素共用同一个 id”。
  assertUniqueIds(parsed, input.path);
  assertNormalized(parsed, input.path);
  // miss 的码由 `locateTarget` 出，`readNode` 只管命中后的读取；同一串解析两次是代价，不是语义。
  const result = readOnce(parsed, locateTarget(parsed, input.target).selector, input.maxBytes);
  return input.json ? jsonOk(dataRead(result, idsOf(result.html))) : humanRead(result);
};
