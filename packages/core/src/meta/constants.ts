// 这层管：`hr-meta` 的类型与状态常量；不解析 JSON、不产出诊断。

import type { Diagnostic } from "../html/constants";

/** 旧版（M1.x）meta 的待处理状态；新版阅读器写的是 `pending`。 */
const PENDING_ANNOTATION_STATUS = "pending_ai";

/** 进 `pendingAnnotations` 的状态：旧版 `pending_ai` 与阅读器写入的 `pending` 都算（与 `annotations/model` 的两态归一同口径）。 */
export const PENDING_ANNOTATION_STATUSES: ReadonlySet<string> = new Set([
  PENDING_ANNOTATION_STATUS,
  "pending",
]);

export interface MetaAnnotation {
  readonly id: string;
  readonly targetId: string;
  readonly comment: string;
  readonly status: string;
}

export interface ParsedMeta {
  readonly annotations: readonly MetaAnnotation[];
  readonly diagnostics: readonly Diagnostic[];
}
