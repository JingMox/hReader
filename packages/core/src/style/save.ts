// 这层管：风格文本落盘（先校验 → 挡越界与覆盖 → 原子写）；不生成内容、不读语料。

import { dirname, isAbsolute, relative, resolve } from "node:path";

import { HrError } from "../hr-error";
import { writeAtomic } from "../io/atomic";
import { encodeUtf8 } from "../io/bytes";

import type { StyleDeps, StyleSpec } from "./contracts";
import { existsOf } from "./resource";
import { parseStyleText } from "./spec";

export interface SaveStyleTextInput {
  readonly path: string;
  readonly workspace: string;
  readonly text: string;
  readonly force: boolean;
}

export interface SavedStyle {
  readonly path: string;
  readonly spec: StyleSpec;
}

/** 与 `applyStyle` 的守卫同一口径：`--out` 落在 workspace 外一律拒绝，不就地猜相对根。 */
const resolvedPathOf = (path: string, workspace: string): string => {
  const target = resolve(workspace, path);
  const rel = relative(workspace, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new HrError(
      "path_outside_workspace",
      `风格只能写到 workspace 内：${target} 不在 ${workspace}`,
    );
  }
  return target;
};

/**
 * 校验在写盘之前：产物写坏比写不出去更糟——用户之后每次 `hr style` 都会撞上它。
 * 已存在时默认拒绝（`file_exists`），`force` 才覆盖。
 * 父目录不自动建（AC-6）：风格目录的层级有语义（`.hreader/styles/<id>/`），
 * 替用户 `mkdir -p` 会把打错的路径变成一个看起来合法的风格。
 */
export const saveStyleText = async (
  input: SaveStyleTextInput,
  deps: StyleDeps,
): Promise<SavedStyle> => {
  const path = resolvedPathOf(input.path, input.workspace);
  const spec = parseStyleText(input.text, path);
  if (!input.force && (await existsOf(path, deps))) {
    throw new HrError("file_exists", `目标已存在：${path}（加 --force 覆盖）`);
  }
  if (!(await existsOf(dirname(path), deps))) {
    throw new HrError("invalid_input", `父目录不存在：${dirname(path)}`);
  }
  await writeAtomic({ path, workspace: input.workspace, data: encodeUtf8(input.text) }, deps);
  return { path, spec };
};
