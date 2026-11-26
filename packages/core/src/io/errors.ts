// 这层管：把系统错误翻译成冻结的错误码（缺文件与真故障分开，`cause` 一律保留），
// 以及套着同一套翻译的删除端口包壳；不改报文语义。

import { HrError } from "../hr-error";
import type { FileSystem } from "./ports";

/**
 * 只把 `code` 原样取出、不做类型收窄：下面的判断全是与字面量比相等，非字符串自然不等，
 * 因此省掉了“不是字符串”这条永远测不到的分支。
 */
export const codeOf = (error: unknown): unknown => Reflect.get(Object(error), "code");

/** `ENOENT` means "the input points at the wrong path", everything else is an io failure: the two must carry different codes so tests can tell them apart. */
export const isMissing = (error: unknown): boolean => codeOf(error) === "ENOENT";

/** `EEXIST` 是锁的"已被别人持有"，不是故障：调用方要据此重试。 */
export const isExists = (error: unknown): boolean => codeOf(error) === "EEXIST";

/** `EACCES`/`EPERM` 是权限不足，不是磁盘或路径坏了：用户看到 `.hreader/locks` 这类内部路径时必须知道该改权限。 */
const isDenied = (error: unknown): boolean =>
  codeOf(error) === "EACCES" || codeOf(error) === "EPERM";

const permissionHint = (error: unknown): string =>
  isDenied(error) ? "（权限不足：给该目录/文件写权限后重试，或先 chmod）" : "";

export const ioFailure = (action: string, path: string, error: unknown): HrError =>
  new HrError("io_failure", `${action}失败：${path}${permissionHint(error)}`, { cause: error });

/** `ENAMETOOLONG`/`EINVAL` 是"名字不合法"而非磁盘故障：与 static.ts 的 BAD_NAME 同一口径，按 not_a_file 处理。 */
const BAD_NAME = new Set(["ENAMETOOLONG", "EINVAL"]);

/** 缺文件/非法名 → `not_a_file`（调用方指错了路），其余 → `io_failure`。 */
export const failureOf = (action: string, path: string, error: unknown): HrError => {
  const code = codeOf(error);
  if (isMissing(error) || (typeof code === "string" && BAD_NAME.has(code))) {
    return new HrError("not_a_file", `${action}时路径不存在：${path}`, { cause: error });
  }
  return ioFailure(action, path, error);
};

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
