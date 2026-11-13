// 这层管：把系统错误翻译成冻结的错误码（缺文件与真故障分开，`cause` 一律保留）；不改报文语义。

import { HrError } from "../hr-error";

/**
 * 只把 `code` 原样取出、不做类型收窄：下面的判断全是与字面量比相等，非字符串自然不等，
 * 因此省掉了“不是字符串”这条永远测不到的分支。
 */
export const codeOf = (error: unknown): unknown => Reflect.get(Object(error), "code");

/** `ENOENT` 是"输入指错了"，其余才算 io 故障：两者必须给不同 code，测试员才好断言。 */
export const isMissing = (error: unknown): boolean => codeOf(error) === "ENOENT";

/** `EEXIST` 是锁的"已被别人持有"，不是故障：调用方要据此重试。 */
export const isExists = (error: unknown): boolean => codeOf(error) === "EEXIST";

export const ioFailure = (action: string, path: string, error: unknown): HrError =>
  new HrError("io_failure", `${action}失败：${path}`, { cause: error });

/** 缺文件 → `not_a_file`（调用方指错了路），其余 → `io_failure`。 */
export const failureOf = (action: string, path: string, error: unknown): HrError =>
  isMissing(error)
    ? new HrError("not_a_file", `${action}时路径不存在：${path}`, { cause: error })
    : ioFailure(action, path, error);
