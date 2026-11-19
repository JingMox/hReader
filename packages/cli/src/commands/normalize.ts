// 这层管：`hr normalize`（补齐 data-hr-id，可选原地写回）→ 文本/JSON；不解析参数、不判断退出码。

import { nodePatchDeps, normalizeFile } from "@hreader/core";

import { dataNormalize, humanNormalizeWritten, jsonOk } from "../output";

export interface NormalizeInput {
  /** workspace 内的相对路径（与 patch 同一口径）。 */
  readonly path: string;
  readonly workspace: string;
  readonly write: boolean;
  readonly json: boolean;
  /** 回执里印的路径（用户视角）：不给就印结果里的真实路径。 */
  readonly displayPath?: string | undefined;
}

export const normalizeCommand = async (input: NormalizeInput): Promise<string> => {
  const result = await normalizeFile(
    { workspace: input.workspace, file: input.path, write: input.write },
    nodePatchDeps,
  );
  if (input.json) return jsonOk(dataNormalize(result));
  // 不写回时 stdout 就是规范化结果本身（不多补换行）：`hr normalize a.html > b.html` 要逐字节可用。
  return input.write
    ? humanNormalizeWritten(result, input.displayPath ?? result.path)
    : result.html;
};
