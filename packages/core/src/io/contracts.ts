// 这层管：io 对外的裸入参/结果类型；不含逻辑、不碰 fs。

import type { PatchRequest } from "../ops/patchNode";

export interface PatchTargetInput {
  readonly workspace: string;
  readonly file: string;
}

export interface PatchFileInput extends PatchTargetInput {
  readonly request: PatchRequest;
}

export interface PatchOptions {
  /** 抢锁上限；并发测试要在秒级断言 `locked`，必须能调。 */
  readonly lockTimeoutMs?: number;
}

export interface PatchResult {
  readonly path: string;
  readonly bytes: number;
  readonly newIds: readonly string[];
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
