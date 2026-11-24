// 这层管：把 `<script id="hr-meta">` 的 JSON 读成类型化批注；不校验 targetId 是否存在（消费方做）。

import {
  type Diagnostic,
  DIAGNOSTIC_SEVERITY,
  type HtmlElementNode,
  type HtmlNode,
  META_SCRIPT_ID,
  type ParsedHtml,
} from "../html/constants";
import { drainStack } from "../html/stack";
import { textContentOf } from "../html/text";
import { attributeOf } from "../model/attrs";
import type { MetaAnnotation, ParsedMeta } from "./constants";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const invalidMeta = (message: string): Diagnostic => ({
  code: "invalid_meta",
  severity: DIAGNOSTIC_SEVERITY.invalid_meta,
  message,
});

const stringFieldOf = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

/** `JSON.parse` 只在赋值处接触 `unknown`：不写 `as`，也不让 `any` 流向调用方。 */
const parseJson = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
};

const findMetaScript = (root: HtmlNode): HtmlElementNode | undefined => {
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
    // 与 `html/parse.ts` 同口径：meta 脚本按 HTML 原生 `id` 属性识别（不是 `data-hr-id`）。
    if (current.tag === "script" && attributeOf(current, "id") === META_SCRIPT_ID) {
      return current;
    }
    for (const child of current.children) {
      stack.push(child);
    }
  }
  return undefined;
};

const annotationOf = (
  value: unknown,
  index: number,
  diagnostics: Diagnostic[],
): MetaAnnotation | undefined => {
  if (!isRecord(value)) {
    diagnostics.push(invalidMeta(`annotations[${String(index)}] 不是对象，已跳过`));
    return undefined;
  }
  const id = stringFieldOf(value, "id");
  // 阅读器写的是新字段（`nodeId`/`note`），旧版 meta 是 `targetId`/`comment`：两套都要读得出来。
  const targetId = stringFieldOf(value, "targetId") ?? stringFieldOf(value, "nodeId");
  if (id === undefined || targetId === undefined) {
    diagnostics.push(invalidMeta(`annotations[${String(index)}] 缺少字符串 id/targetId，已跳过`));
    return undefined;
  }
  return {
    id,
    targetId,
    comment: stringFieldOf(value, "comment") ?? stringFieldOf(value, "note") ?? "",
    status: stringFieldOf(value, "status") ?? "",
  };
};

const annotationsOf = (value: unknown): ParsedMeta => {
  if (value === undefined) {
    return { annotations: [], diagnostics: [] };
  }
  if (!isUnknownArray(value)) {
    return { annotations: [], diagnostics: [invalidMeta("hr-meta.annotations 不是数组")] };
  }
  const diagnostics: Diagnostic[] = [];
  const annotations: MetaAnnotation[] = [];
  value.forEach((item, index) => {
    const annotation = annotationOf(item, index, diagnostics);
    if (annotation !== undefined) {
      annotations.push(annotation);
    }
  });
  return { annotations, diagnostics };
};

/** 缺 `<script id="hr-meta">` 是合法形态：返回空批注且**不**发诊断。 */
export const readMeta = (parsed: ParsedHtml): ParsedMeta => {
  const script = findMetaScript(parsed.root);
  if (script === undefined) {
    return { annotations: [], diagnostics: [] };
  }
  const text = textContentOf(script).trim();
  if (text === "") {
    return { annotations: [], diagnostics: [invalidMeta("hr-meta 为空")] };
  }
  const value = parseJson(text);
  if (value === undefined) {
    return { annotations: [], diagnostics: [invalidMeta("hr-meta 不是合法 JSON")] };
  }
  if (!isRecord(value)) {
    return { annotations: [], diagnostics: [invalidMeta("hr-meta 顶层不是对象")] };
  }
  return annotationsOf(value["annotations"]);
};
