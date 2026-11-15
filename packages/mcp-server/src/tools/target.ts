// 这层管：`filePath` → core 能吃的 `{workspace, file}`，以及本包唯一那道边界判定（读与建共用同一个口径）。

import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { HrError } from "@hreader/core";

export interface DocumentTarget {
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

/** 与 core 的 `io/errors.ts` 同形：只把 `code` 原样取出、不做类型收窄，非字符串自然比不相等。 */
const codeOf = (error: unknown): unknown => Reflect.get(Object(error), "code");

/**
 * 要新建的目标还不存在，`realpath` 会 `ENOENT`（父级是文件时是 `ENOTDIR`）：退到最近的既存祖先。
 * 根目录必然解析得出来，所以这个循环只从 `return` 收尾；其余错误原样抛出（"解析不了"不等于"就在界内"）。
 */
const realpathOfExisting = async (candidate: string): Promise<string> => {
  for (;;) {
    try {
      return await realpath(candidate);
    } catch (error: unknown) {
      const code = codeOf(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      candidate = dirname(candidate);
    }
  }
};

/**
 * 边界判定（本包只此一处，读、建同一个口径）：目标本身、或它最近的既存祖先，`realpath`
 * 之后必须落在 `realpath(workspace)` 之内。
 * 两件事靠它成立：一是符号链接逃逸（`ln -s /tmp workspace/link` 之后传 `link/x.html`）被拒；
 * 二是**顺序**——调用方必须在 `mkdir`/`writeFile` 之前调用它，反了就是先把目录建出去再发现越界。
 */
export const assertInsideWorkspace = async (target: DocumentTarget): Promise<void> => {
  const [workspace, absolute] = await Promise.all([
    realpath(target.workspace),
    realpathOfExisting(target.absolute),
  ]);
  const inside = relative(workspace, absolute);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new HrError("path_outside_workspace", `目标不在工作区内：${target.absolute}`);
  }
};

/** 只读工具（outline/read_node）不落盘、core 也没有公开的"读文本"入口，所以判定完直接读。 */
export const readInsideWorkspace = async (target: DocumentTarget): Promise<string> => {
  await assertInsideWorkspace(target);
  return readFile(target.absolute, "utf8");
};
