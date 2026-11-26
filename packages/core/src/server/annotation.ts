// 这层管：把一条批注按源码区间写回 `<script id="hr-meta">`（只改该 script 的内部文本）；不落盘、不加锁。

import { elementsOf, insertMeta } from "../annotations/meta-insert";
import { normalizeStatus, type Annotation } from "../annotations/model";
import { HrError } from "../hr-error";
import { type HtmlElementNode, HR_ID_ATTRIBUTE, META_SCRIPT_ID } from "../html/constants";
import { parseHtml } from "../html/parse";
import { spanOf } from "../html/span";
import { attributeOf } from "../model/attrs";
import { jsonArray, jsonObject, parseJson } from "../schema";

export interface AnnotationInput {
  /** 块内字符偏移（含头不含尾），与 `Lint` 的偏移同一口径。 */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly note: string | undefined;
  readonly status: string;
}

export interface AnnotationOutcome {
  readonly html: string;
  readonly newId: string;
  readonly changed: boolean;
}

const META_OPEN = `<script id="${META_SCRIPT_ID}">`;
const META_CLOSE = "</script>";

/** `</script>` 必须转义，否则批注正文能提前闭合 meta 脚本（与正文注入同一类问题）。 */
const scriptSafeJson = (value: unknown): string => JSON.stringify(value).replaceAll("</", "<\\/");

const isInteger = (value: number): boolean => Number.isInteger(value);

const checkRange = (html: string, input: AnnotationInput): void => {
  if (!isInteger(input.start) || !isInteger(input.end)) {
    throw new HrError("invalid_input", "start/end 必须是整数偏移");
  }
  if (input.start < 0 || input.end <= input.start || input.end > html.length) {
    throw new HrError("invalid_input", `偏移越界：${String(input.start)}..${String(input.end)}`);
  }
  if (input.text.length === 0) throw new HrError("invalid_input", "text 不能为空");
};

/** 覆盖 `[start, end)` 的最内层元素：区间更小的那个才是"批注真正落在哪"。 */
const deepestContaining = (
  elements: readonly HtmlElementNode[],
  start: number,
  end: number,
): HtmlElementNode | undefined => {
  let best: HtmlElementNode | undefined;
  let bestWidth = Number.MAX_SAFE_INTEGER;
  for (const element of elements) {
    const span = spanOf(element);
    // 只有真实出现的元素能"覆盖"：合成节点（片段里的 `html/head/body`）区间零宽，直接跳过。
    if (span.end <= span.start) continue;
    if (span.start > start || end > span.end) continue;
    const width = span.end - span.start;
    if (width < bestWidth) {
      best = element;
      bestWidth = width;
    }
  }
  return best;
};

const targetIdOf = (elements: readonly HtmlElementNode[], start: number, end: number): string => {
  const element = deepestContaining(elements, start, end);
  return element === undefined ? "root" : (attributeOf(element, HR_ID_ATTRIBUTE) ?? "root");
};

/**
 * 记录形状必须与 `readAnnotations` 的必填判定同口径：`nodeId` / `anchor.exact` / `createdAt` 缺任一，
 * 卡片会被当成脏数据跳过——写成功、读不回来就是批注当场丢（容错不能替写入缺陷兜底）。
 */
const recordOf = (
  elements: readonly HtmlElementNode[],
  input: AnnotationInput,
  newId: string,
  createdAt: string,
): Annotation => ({
  id: newId,
  nodeId: targetIdOf(elements, input.start, input.end),
  // 片段路径拿不到文档侧的上下文，前缀/后缀留空；`start` 只是消歧提示，仍是片段内偏移。
  anchor: { exact: input.text, prefix: "", suffix: "", start: input.start },
  note: input.note ?? input.text,
  status: normalizeStatus(input.status) ?? "pending",
  createdAt,
});

const annotationsOfMeta = (inner: string, file: string): readonly unknown[] => {
  if (inner.trim().length === 0) return [];
  const value = parseJson(inner);
  if (value === undefined) throw new HrError("invalid_document", `hr-meta 不是合法 JSON：${file}`);
  const root = jsonObject.safeParse(value);
  if (!root.success) throw new HrError("invalid_document", `hr-meta 顶层不是对象：${file}`);
  const annotations = jsonArray.optional().safeParse(root.data["annotations"]);
  if (!annotations.success) {
    throw new HrError("invalid_document", `hr-meta.annotations 不是数组：${file}`);
  }
  return annotations.data ?? [];
};

/**
 * 返回新 id 与整篇新文本；调用方负责加锁与原子写。
 * `createdAt` 由调用方从注入的时钟取（本层不读时钟），与 `annotation-ops` 的时间来源同一处。
 * `changed` 恒为真（追加一条批注必然改变文本），保留字段是为了和 `patch/style` 同一形状。
 */
export const appendAnnotation = (
  html: string,
  input: AnnotationInput,
  newId: string,
  createdAt: string,
): AnnotationOutcome => {
  checkRange(html, input);
  const parsed = parseHtml(html, { locations: true });
  const elements = elementsOf(parsed.root);
  const record = recordOf(elements, input, newId, createdAt);
  const meta = elements.find(
    (element) => element.tag === "script" && attributeOf(element, "id") === META_SCRIPT_ID,
  );
  const metaSpan = spanOf(meta);
  if (metaSpan === null || metaSpan.end <= metaSpan.start) {
    const script = `${META_OPEN}${scriptSafeJson({ annotations: [record] })}${META_CLOSE}`;
    const next = insertMeta(html, script);
    return { html: next, newId, changed: next !== html };
  }
  const inner = html.slice(metaSpan.innerStart, metaSpan.innerEnd);
  const annotations = annotationsOfMeta(inner, "hr-meta");
  const next = `${html.slice(0, metaSpan.innerStart)}${scriptSafeJson({ annotations: [...annotations, record] })}${html.slice(metaSpan.innerEnd)}`;
  return { html: next, newId, changed: next !== html };
};
