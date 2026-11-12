// 这层管：`hr-meta` 的类型与状态常量；不解析 JSON、不产出诊断。

import type { Diagnostic } from "../html/constants";

/** 唯一进 `pendingAnnotations` 的状态；其余状态由上层判断。 */
export const PENDING_ANNOTATION_STATUS = "pending_ai";

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
