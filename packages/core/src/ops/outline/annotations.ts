// 这层管：从 meta 批注里挑出 `pending_ai` 并校验 targetId 是否存在；不改文档、不写回。

import {
  type Diagnostic,
  DIAGNOSTIC_SEVERITY,
  HR_ID_ATTRIBUTE,
  type HtmlNode,
} from "../../html/constants";
import { drainStack } from "../../html/stack";
import { PENDING_ANNOTATION_STATUS, type MetaAnnotation } from "../../meta";
import { attributeOf } from "../../model/attrs";
import { OUTLINE_ANNOTATION_LIMIT, type PendingAnnotation } from "./constants";
import { truncate } from "./text";

interface PendingResult {
  readonly pending: readonly PendingAnnotation[];
  readonly diagnostics: readonly Diagnostic[];
}

/** 文档里出现过的全部 `data-hr-id` 值（不校验合法性：引用存在即算存在）。 */
const idsOf = (root: HtmlNode): ReadonlySet<string> => {
  const ids = new Set<string>();
  const stack: HtmlNode[] = [root];
  for (const current of drainStack(stack)) {
    if (current.kind === "document") {
      for (const child of current.children) {
        stack.push(child);
      }
      continue;
    }
    if (current.kind !== "element") {
      continue;
    }
    const id = attributeOf(current, HR_ID_ATTRIBUTE);
    if (id !== undefined) {
      ids.add(id);
    }
    for (const child of current.children) {
      stack.push(child);
    }
  }
  return ids;
};

export const pendingAnnotations = (
  annotations: readonly MetaAnnotation[],
  root: HtmlNode,
): PendingResult => {
  const ids = idsOf(root);
  const pending: PendingAnnotation[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const annotation of annotations) {
    if (annotation.status !== PENDING_ANNOTATION_STATUS) {
      continue;
    }
    pending.push({
      id: annotation.id,
      targetId: annotation.targetId,
      comment: truncate(annotation.comment, OUTLINE_ANNOTATION_LIMIT),
    });
    if (!ids.has(annotation.targetId)) {
      diagnostics.push({
        code: "annotation_target_missing",
        severity: DIAGNOSTIC_SEVERITY.annotation_target_missing,
        message: `批注 ${annotation.id} 的 targetId="${annotation.targetId}" 在文档里不存在`,
      });
    }
  }
  return { pending, diagnostics };
};
