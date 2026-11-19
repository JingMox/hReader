// 这层管：`hr patch`（片段文本已解析好 → core 落盘 → 文本/JSON）；不做参数校验、不读 stdin。
// 入口先做与 `outline`/`read` 同一道「文档已 normalize」前置判定：patch 消耗 `data-hr-id`，
// 半规范化（根有 id、子节点没有）的文档在这里就要收，否则用户会拿到 `node_not_found` 这种猜字式的报错（P2-2）。

import { join } from "node:path";

import { type PatchAction, isInside, nodePatchDeps, parseHtml, patchFile } from "@hreader/core";

import { assertIsDocument, assertNormalized, withNormalizeAdvice } from "../document-normalize";
import { readTextFile } from "../input";
import { dataPatch, humanPatch, jsonOk } from "../output";

export interface PatchInput {
  readonly path: string;
  readonly nodeId: string;
  readonly action: PatchAction;
  /** `delete` 时必须为 `undefined`；其余 action 是已取好的片段原文。 */
  readonly html: string | undefined;
  readonly workspace: string;
  readonly json: boolean;
  /** 回执里印的路径（用户视角）：不给就印结果里的真实路径。 */
  readonly displayPath?: string | undefined;
}

/**
 * 入口先做与 `outline`/`read` 同一道「文档已 normalize」前置判定：patch 消耗 `data-hr-id`，
 * 半规范化（根有 id、子节点没有）的文档在这里就要收，否则用户会拿到 `node_not_found` 这种猜字式的报错（P2-2）。
 * 读不到就不抢答：`path_outside_workspace`、`not_a_file`、`realpath时路径不存在` 这些诊断留给 core 的 `resolveTarget`。
 */
const assertPatchable = async (input: PatchInput): Promise<void> => {
  const absolute = join(input.workspace, input.path);
  if (!isInside(input.workspace, absolute)) return;
  let text: string;
  try {
    text = await readTextFile(absolute);
  } catch {
    return;
  }
  const parsed = parseHtml(text);
  assertIsDocument(parsed, input.path);
  assertNormalized(parsed, input.path);
};

export const patchCommand = async (input: PatchInput): Promise<string> => {
  await assertPatchable(input);
  const request =
    input.html === undefined
      ? { targetId: input.nodeId, action: input.action }
      : { targetId: input.nodeId, action: input.action, html: input.html };
  try {
    const result = await patchFile(
      { workspace: input.workspace, file: input.path, request },
      nodePatchDeps,
    );
    return input.json
      ? jsonOk(dataPatch(result))
      : humanPatch(result, input.displayPath ?? result.path);
  } catch (error: unknown) {
    throw withNormalizeAdvice(error, input.path);
  }
};
