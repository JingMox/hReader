// 这层管：不抛异常的文档加载（先分档，只有托管档才派生模型）；解码/解析层的错误仍向上抛。

import type { ParsedHtml } from "../html/constants";
import { classifyDocument, type Classification } from "./classify";
import type { DocumentModel } from "./constants";
import { toDocumentModel } from "./derive";

export type DocumentLoad =
  | { readonly ok: true; readonly cls: "managed"; readonly model: DocumentModel }
  | { readonly ok: false; readonly classification: Classification };

/**
 * `toDocumentModel` 的严格性不动：这里靠分类把"derive 必抛"的情况提前分流，
 * 而不是派生失败再吞异常——外来文档反复触发大对象异常会把 CPU 与日志刷爆。
 */
export const loadDocument = (parsed: ParsedHtml): DocumentLoad => {
  const classification = classifyDocument(parsed);
  if (classification.cls !== "managed") return { ok: false, classification };
  return { ok: true, cls: "managed", model: toDocumentModel(parsed) };
};
