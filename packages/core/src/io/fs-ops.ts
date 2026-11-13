// 这层管：删除类端口调用的包壳；不含策略、不管顺序。

import { failureOf } from "./errors";
import type { FileSystem } from "./ports";

export const unlinkOf = async (fsApi: FileSystem, path: string): Promise<void> => {
  try {
    await fsApi.unlink(path);
  } catch (error: unknown) {
    throw failureOf("删除", path, error);
  }
};

/** 清理用：删不掉不代表原文件坏了，所以不回抛（否则会盖住真正的失败原因）。 */
export const unlinkQuiet = async (fsApi: FileSystem, path: string): Promise<void> => {
  try {
    await fsApi.unlink(path);
  } catch {
    // tmp 可能压根没建出来；原文件此时未受影响，错误由调用点抛出。
  }
};
