// 这层管：`hr patch`（片段文本已解析好 → core 落盘 → 文本/JSON）；不做参数校验、不读 stdin。
// 入口做与 `outline`/`read` 同一道「文档已 normalize」前置判定：patch 消耗 `data-hr-id`，
// 半规范化（根有 id、子节点没有）的文档在这里就要收，否则用户会拿到 `node_not_found` 这种猜字式的报错（P2-2）。
// `<nodeId|选择器>` 的解释与 `read` 同一处实现（core 的 `locateTarget`）：两条命令同输入必须同 id。

import {
  type PatchAction,
  type PatchRequest,
  nodePatchDeps,
  parseHtml,
  patchFile,
  patchTargetIdOf,
} from "@hreader/core";

import {
  assertIsDocument,
  assertNormalized,
  assertUniqueIds,
  withNormalizeAdvice,
} from "../document-normalize";
import { dataPatch, humanPatch, jsonOk } from "../output";

export interface PatchInput {
  readonly path: string;
  /** `data-hr-id` 或选择器（与 `hr read` 同一解析器）：解析在 core 的锁内做，此层不先读盘。 */
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
 * 整段判定与定位都交给 core 在锁内、对着**将要写入的那份字节**跑（`request` 以函数形式给）：
 * 命令层若先锁外读一遍盘，判定的是一份快照，两次读之间文档可被别人改掉，定位到的就是另一棵树上的节点。
 * 顺序仍是「是不是文档 → 重复 id → 缺 id → 定位」：重复 id 排在 `needs_normalize` 前面，
 * 那是“缺 id”，这是“两个元素共用同一个 id”。
 */
const requestOf =
  (input: PatchInput) =>
  (html: string): PatchRequest => {
    const parsed = parseHtml(html);
    assertIsDocument(parsed, input.path);
    assertUniqueIds(parsed, input.path);
    assertNormalized(parsed, input.path);
    const targetId = patchTargetIdOf(parsed, input.nodeId);
    return input.html === undefined
      ? { targetId, action: input.action }
      : { targetId, action: input.action, html: input.html };
  };

export const patchCommand = async (input: PatchInput): Promise<string> => {
  try {
    const result = await patchFile(
      { workspace: input.workspace, file: input.path, request: requestOf(input) },
      nodePatchDeps,
    );
    return input.json
      ? jsonOk(dataPatch(result))
      : humanPatch(result, input.displayPath ?? result.path);
  } catch (error: unknown) {
    throw withNormalizeAdvice(error, input.path);
  }
};
