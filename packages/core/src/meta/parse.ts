// 这层管：把 `<script id="hr-meta">` 的 JSON 读成类型化批注；不校验 targetId 是否存在（消费方做）。

import { z } from "zod";

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
import { jsonArray, jsonObject, looseString, parseJson } from "../schema";
import type { MetaAnnotation, ParsedMeta } from "./constants";

const invalidMeta = (message: string): Diagnostic => ({
  code: "invalid_meta",
  severity: DIAGNOSTIC_SEVERITY.invalid_meta,
  message,
});

/** 阅读器写的是新字段（`nodeId`/`note`），旧版 meta 是 `targetId`/`comment`：两套都要读得出来。 */
const annotationSchema = z.object({
  id: looseString,
  targetId: looseString,
  nodeId: looseString,
  comment: looseString,
  note: looseString,
  status: looseString,
});

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
  const parsed = annotationSchema.safeParse(value);
  if (!parsed.success) {
    diagnostics.push(invalidMeta(`annotations[${String(index)}] 不是对象，已跳过`));
    return undefined;
  }
  const { id, targetId = parsed.data.nodeId, comment, note, status } = parsed.data;
  if (id === undefined || targetId === undefined) {
    diagnostics.push(invalidMeta(`annotations[${String(index)}] 缺少字符串 id/targetId，已跳过`));
    return undefined;
  }
  return { id, targetId, comment: comment ?? note ?? "", status: status ?? "" };
};

const annotationsOf = (value: unknown): ParsedMeta => {
  const list = jsonArray.optional().safeParse(value);
  if (!list.success) {
    return { annotations: [], diagnostics: [invalidMeta("hr-meta.annotations 不是数组")] };
  }
  const diagnostics: Diagnostic[] = [];
  const annotations: MetaAnnotation[] = [];
  (list.data ?? []).forEach((item, index) => {
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
  const root = jsonObject.safeParse(value);
  if (!root.success) {
    return { annotations: [], diagnostics: [invalidMeta("hr-meta 顶层不是对象")] };
  }
  return annotationsOf(root.data["annotations"]);
};
