// 这层管：`filePath` → core 能吃的 `{workspace, file}`，以及只读工具读文本前的那道边界检查。

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { HrError } from "@hreader/core";

interface DocumentTarget {
  /** 边界（core 的 `workspace`）。 */
  readonly workspace: string;
  /** 相对 `workspace` 的路径：core 的 `resolveTarget` 自己会 realpath + 拒逃逸。 */
  readonly file: string;
  readonly absolute: string;
}

export const documentTargetOf = (filePath: string, cwd: string): DocumentTarget => {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  return { workspace: cwd, file: relative(cwd, absolute), absolute };
};

/**
 * 写路径的逃逸判定在 core 的 `resolveTarget` 里（适配层不复制它）。只读工具（outline/read_node）
 * 不落盘、core 也没有公开的"读文本"入口，所以这里用同一个原语（realpath）补一道同语义的边界，
 * 避免把任意绝对路径的内容读给模型。判定口径与 core 一致：realpath 后不得在 workspace 之外。
 */
export const readInsideWorkspace = async (target: DocumentTarget): Promise<string> => {
  const [workspace, absolute] = await Promise.all([
    realpath(target.workspace),
    realpath(target.absolute),
  ]);
  const inside = relative(workspace, absolute);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new HrError("path_outside_workspace", `目标不在工作区内：${target.absolute}`);
  }
  return readFile(absolute, "utf8");
};
