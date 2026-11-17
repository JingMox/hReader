// 这层管：把路径换成真实路径（软链解析，缺失后缀由最深的已存在祖先补全）；不判存在性、不读内容。
// 判定"两个路径是否同一个"必须走这里：一边 realpath、另一边只 resolve，macOS 的 `/tmp` → `/private/tmp`
// 就会把同一个文件判成两个，提示随之说假话（R30-2）。

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** 不存在（或父链断了）时返回 undefined：调用方要自己决定这算错误还是走补全。 */
export const attemptRealpath = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/** 目标可能尚不存在（patch 允许新建）：缺失后缀由最深的已存在祖先补全。 */
export const realpathThroughAncestors = (path: string): string => {
  const real = attemptRealpath(path);
  if (real !== undefined) return real;
  const parent = dirname(path);
  return join(realpathThroughAncestors(parent), path.slice(parent.length + 1));
};
