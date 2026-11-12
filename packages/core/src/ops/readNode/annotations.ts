// 这层管：把 `hr-meta` 中目标 id 的批注投影成 `PendingAnnotation`；不按状态过滤、不排序。

import {
  type Diagnostic,
  type DiagnosticCode,
  DIAGNOSTIC_SEVERITY,
  type HtmlElementNode,
  type HtmlNode,
  META_SCRIPT_ID,
  type ParsedHtml,
} from "../../html/constants";
import { readMeta } from "../../meta";
import { drainStack } from "../../html/stack";
import { textContentOf } from "../../html/text";
import type { PendingAnnotation } from "../outline";
import { attributeOf } from "./attrs";

/** `docs/02` 的正典形态：`{version, style, annotations}`；只校验顶层键名，不校验值形状。 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set(["version", "style", "annotations"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const diagnosticOf = (code: DiagnosticCode, message: string): Diagnostic => ({
  code,
  severity: DIAGNOSTIC_SEVERITY[code],
  message,
});

/** 与 `src/meta/parse.ts` 同口径：meta 脚本按 HTML 原生 `id` 识别（不是 `data-hr-id`）。 */
const findMetaScript = (root: HtmlNode): HtmlElementNode | undefined => {
  const stack: HtmlNode[] = [root];
  for (const current of drainStack(stack)) {
    if (
      current.kind === "element" &&
      current.tag === "script" &&
      attributeOf(current, "id") === META_SCRIPT_ID
    ) {
      return current;
    }
    if (current.kind === "element" || current.kind === "document") {
      for (const child of current.children) {
        stack.push(child);
      }
    }
  }
  return undefined;
};

/** 取 `hr-meta` 的原始文本：字段名检查要看整个对象，而 `readMeta` 只投影 `annotations`。 */
const metaText = (parsed: ParsedHtml): string => {
  const script = findMetaScript(parsed.root);
  return script === undefined ? "" : textContentOf(script);
};

const unknownFields = (parsed: ParsedHtml): readonly string[] => {
  try {
    const payload: unknown = JSON.parse(metaText(parsed));
    return isRecord(payload) ? Object.keys(payload).filter((key) => !KNOWN_FIELDS.has(key)) : [];
  } catch {
    // JSON 不合法的报文由 `readMeta` 负责，这里不重复报。
    return [];
  }
};

/** 字段名写错（如把 `annotations` 写成 `pending_annotations`）会让整批批注静默消失，必须出声。 */
export const metaFieldDiagnostics = (parsed: ParsedHtml): readonly Diagnostic[] =>
  unknownFields(parsed).map((field) =>
    diagnosticOf(
      "invalid_meta",
      `hr-meta 含未知字段 "${field}"（只接受 "version" / "style" / "annotations"）`,
    ),
  );

/**
 * 与 `buildOutline` 的刻意差异：这里**不**看 `status`，`resolved` 等已完结批注也返回——
 * 节点读取要复原上下文，而不是待办列表。
 */
export const annotationsFor = (
  parsed: ParsedHtml,
  targetId: string | undefined,
): readonly PendingAnnotation[] => {
  if (targetId === undefined) {
    return [];
  }
  const result: PendingAnnotation[] = [];
  for (const annotation of readMeta(parsed).annotations) {
    if (annotation.targetId === targetId) {
      result.push({
        id: annotation.id,
        targetId: annotation.targetId,
        comment: annotation.comment,
      });
    }
  }
  return result;
};
