// 这层管：把一条批注按源码区间写回 `<script id="hr-meta">`（只改该 script 的内部文本）；不落盘、不加锁。

import { HrError } from "../hr-error";
import {
  type HtmlElementNode,
  type HtmlNode,
  HR_ID_ATTRIBUTE,
  META_SCRIPT_ID,
} from "../html/constants";
import { parseHtml } from "../html/parse";
import { attributeOf } from "../model/attrs";

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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const elementsOf = (root: HtmlNode): readonly HtmlElementNode[] => {
  const out: HtmlElementNode[] = [];
  const stack: HtmlNode[] = [root];
  // 数组迭代器按下标走，循环中 `push` 进去的子节点会被同一轮访问到（等价于先前的 pop 循环）。
  for (const current of stack) {
    if (current.kind === "element") out.push(current);
    if (current.kind === "document" || current.kind === "element") {
      for (const child of current.children) stack.push(child);
    }
  }
  return out;
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
    const span = element.span;
    // 只有带位置的元素能"覆盖"：无位置或退化区间直接跳过，宽度就地算，不再另开两个含死分支的判据函数。
    if (span === undefined || span.end <= span.start) continue;
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

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const annotationsOfMeta = (inner: string, file: string): readonly unknown[] => {
  if (inner.trim().length === 0) return [];
  let value: unknown;
  try {
    value = JSON.parse(inner);
  } catch (error: unknown) {
    throw new HrError("invalid_document", `hr-meta 不是合法 JSON：${file}`, { cause: error });
  }
  if (!isRecord(value)) throw new HrError("invalid_document", `hr-meta 顶层不是对象：${file}`);
  const annotations = value["annotations"];
  if (annotations === undefined) return [];
  if (!isUnknownArray(annotations))
    throw new HrError("invalid_document", `hr-meta.annotations 不是数组：${file}`);
  return annotations;
};

/** 没有 meta 脚本时插在 `</body>` 前；连 body 都没有（片段文档）就追加到末尾。 */
const insertMeta = (html: string, record: Readonly<Record<string, string>>): string => {
  const block = `${META_OPEN}${scriptSafeJson({ annotations: [record] })}${META_CLOSE}`;
  const closeAt = html.toLowerCase().lastIndexOf("</body>");
  if (closeAt < 0) return `${html}${block}`;
  return `${html.slice(0, closeAt)}${block}${html.slice(closeAt)}`;
};

/**
 * 返回新 id 与整篇新文本；调用方负责加锁与原子写。
 * `changed` 恒为真（追加一条批注必然改变文本），保留字段是为了和 `patch/style` 同一形状。
 */
export const appendAnnotation = (
  html: string,
  input: AnnotationInput,
  newId: string,
): AnnotationOutcome => {
  checkRange(html, input);
  const parsed = parseHtml(html, { locations: true });
  const elements = elementsOf(parsed.root);
  const record = {
    id: newId,
    targetId: targetIdOf(elements, input.start, input.end),
    comment: input.note ?? input.text,
    status: input.status,
  };
  const meta = elements.find(
    (element) => element.tag === "script" && attributeOf(element, "id") === META_SCRIPT_ID,
  );
  if (meta?.span === undefined) {
    const next = insertMeta(html, record);
    return { html: next, newId, changed: next !== html };
  }
  const inner = html.slice(meta.span.innerStart, meta.span.innerEnd);
  const annotations = annotationsOfMeta(inner, "hr-meta");
  const next = `${html.slice(0, meta.span.innerStart)}${scriptSafeJson({ annotations: [...annotations, record] })}${html.slice(meta.span.innerEnd)}`;
  return { html: next, newId, changed: next !== html };
};
