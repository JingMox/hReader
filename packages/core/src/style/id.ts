// 这层管：风格 id 的合法性与路径穿越防线（id 会拼进目录名，一个 `/` 就能逃出去）。

import { HrError } from "../hr-error";

const STYLE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

export const assertStyleId = (id: string): void => {
  if (!STYLE_ID_PATTERN.test(id)) {
    throw new HrError(
      "invalid_style",
      `风格 id 非法：${id}（必须匹配 ${STYLE_ID_PATTERN.source}，禁止 / 与 ..）`,
    );
  }
};
