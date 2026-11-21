// 这层管：io 对外的裸入参/结果类型；不含逻辑、不碰 fs。

import type { Diagnostic } from "../html/constants";
import type { PatchRequest, ReplacedId } from "../ops/patchNode";

export interface PatchTargetInput {
  readonly workspace: string;
  readonly file: string;
}

/**
 * 锁内、读原文之后才决定 request：调用方想「target 定位」与「文档能不能改」都绑在本次要写的那份
 * 字节上就以函数形式给（锁外另读一份快照会把期间被别人改坏的文档放过去）；已自己定位好的直接给对象。
 */
export type PatchRequestOf = (html: string) => PatchRequest;

export interface PatchFileInput extends PatchTargetInput {
  readonly request: PatchRequest | PatchRequestOf;
}

export interface PatchOptions {
  /** 抢锁上限；并发测试要在秒级断言 `locked`，必须能调。 */
  readonly lockTimeoutMs?: number;
}

export interface PatchResult {
  readonly path: string;
  readonly bytes: number;
  readonly newIds: readonly string[];
  /** `replace` 的旧 id → 新 id 映射；其余动作/内容未变时为空。 */
  readonly replacedIds: readonly ReplacedId[];
  /** 片段的解析诊断（`duplicate_attribute` 等）：能落盘但用户得知道字节里少了东西；缺省视作空。 */
  readonly warnings?: readonly Diagnostic[];
  /** 未写盘（`changed: false`）时为 `null`：不留历史是 AC7 的硬要求。 */
  readonly historyPath: string | null;
  readonly changed: boolean;
  readonly undoable: boolean;
}

export interface UndoResult {
  readonly path: string;
  readonly bytes: number;
  readonly restoredFrom: string;
  readonly sha256: string;
}
