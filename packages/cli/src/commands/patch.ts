// 这层管：`hr patch`（片段文本已解析好 → core 落盘 → 文本/JSON）；不做参数校验、不读 stdin。

import { type PatchAction, nodePatchDeps, patchFile } from "@hreader/core";

import { dataPatch, humanPatch, jsonOk } from "../output";

export interface PatchInput {
  readonly path: string;
  readonly nodeId: string;
  readonly action: PatchAction;
  /** `delete` 时必须为 `undefined`；其余 action 是已取好的片段原文。 */
  readonly html: string | undefined;
  readonly workspace: string;
  readonly json: boolean;
}

export const patchCommand = async (input: PatchInput): Promise<string> => {
  const request =
    input.html === undefined
      ? { targetId: input.nodeId, action: input.action }
      : { targetId: input.nodeId, action: input.action, html: input.html };
  const result = await patchFile(
    { workspace: input.workspace, file: input.path, request },
    nodePatchDeps,
  );
  return input.json ? jsonOk(dataPatch(result)) : humanPatch(result);
};
