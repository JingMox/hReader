// 这层管：`hr read`（读文件 → 读节点 → HTML/JSON）；不做参数校验。
// 不在这里临时补 id：算出来的 id 不在盘上，喂回 `patch` 必挂（缺 id 由 `hr normalize` 补到盘上）。
// 第二位置参数先按选择器解析；`invalid_selector` / `node_not_found` 时把原串当 node id 再试一次（R1-P1-1）。

import { type ParsedHtml, HrError, type ReadNodeResult, parseHtml, readNode } from "@hreader/core";

import { assertIsDocument, assertNormalized } from "../document-normalize";
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

const idSelectorOf = (target: string): string => `[data-hr-id="${target}"]`;

const isRetriable = (error: unknown): error is HrError =>
  error instanceof HrError &&
  (error.code === "invalid_selector" || error.code === "node_not_found");
const readOnce = (
  parsed: ParsedHtml,
  target: string,
  maxBytes: number | undefined,
): ReadNodeResult =>
  maxBytes === undefined ? readNode(parsed, target) : readNode(parsed, target, maxBytes);

const BREAKS_ATTRIBUTE_QUOTING = /["\\\n\r]/u;

/** 按字面形态判码：只有 `"`/`\`/换行会让 `[data-hr-id="…"]` 本身非法；不看第二次失败的类型——那会让码依赖运行时实现。 */
const codeOf = (target: string): "invalid_selector" | "node_not_found" =>
  BREAKS_ATTRIBUTE_QUOTING.test(target) ? "invalid_selector" : "node_not_found";

/** 非 `Error` 的抛出物照样出现在报文里，但内部异常类名（`HrError: `）不给用户看。 */
const messageOf = (error: unknown): string =>
  error instanceof HrError ? error.message : String(error);

/** 两种解释都失败：报文同时列出两条路径；`first`/`retry` 只用于拼报文。 */
const bothFailed = (target: string, first: HrError, retry: unknown): never => {
  throw new HrError(
    codeOf(target),
    `读取目标 ${JSON.stringify(target)} 失败：按选择器 → ${first.message}；按 node id → ${messageOf(retry)}`,
  );
};

const readTarget = (
  parsed: ParsedHtml,
  target: string,
  maxBytes: number | undefined,
): ReadNodeResult => {
  try {
    return readOnce(parsed, target, maxBytes);
  } catch (error: unknown) {
    if (!isRetriable(error)) throw error;
    const first = error;
    try {
      return readOnce(parsed, idSelectorOf(target), maxBytes);
    } catch (retry: unknown) {
      return bothFailed(target, first, retry);
    }
  }
};

export const readCommand = async (input: ReadInput): Promise<string> => {
  const parsed = parseHtml(await readTextFile(input.path));
  // 缺 id 的文档不能靠临时注入蒙过去：算出来的 id 不在盘上，喂回 patch 必挂（B-03）。
  assertIsDocument(parsed, input.path);
  assertNormalized(parsed, input.path);
  const result = readTarget(parsed, input.target, input.maxBytes);
  return input.json ? jsonOk(dataRead(result, idsOf(result.html))) : humanRead(result);
};
