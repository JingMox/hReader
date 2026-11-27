// 这层管：TextQuoteSelector 的解析与消歧；纯函数，不 IO、不抛错。
// **失败是返回值**（`anchor_lost` / `orphaned`），不是异常——批注失效时阅读器还要能用。

import type { Annotation, TextAnchor } from "./model";

/** 文档侧只需要两样东西：整块文本与"现存的块 id 集合"。 */
export interface AnchorDocument {
  readonly text: string;
  readonly nodeIds: readonly string[];
}

export type AnchorFailure = "anchor_lost" | "orphaned" | "ambiguous";

export type AnchorResult =
  | { readonly ok: true; readonly start: number; readonly end: number }
  | { readonly ok: false; readonly reason: AnchorFailure };

const occurrenceStarts = (text: string, needle: string): number[] => {
  if (needle === "") return [];
  const starts: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return starts;
    starts.push(at);
    from = at + 1; // 允许自重叠（"aaa" 里找 "aa" 有两处），消歧才不会被重叠吃掉
  }
};

/** 前/后文匹配：空模板视为"不参与消歧"；越界只比**实际存在**的那一段（越界不算失配）。 */
const fitsContext = (text: string, at: number, anchor: TextAnchor): boolean => {
  const prefixFrom = Math.max(0, at - anchor.prefix.length);
  const prefixShown = text.slice(prefixFrom, at);
  const prefixOk =
    anchor.prefix === "" ||
    prefixShown === anchor.prefix.slice(anchor.prefix.length - prefixShown.length);
  const end = at + anchor.exact.length;
  const suffixShown = text.slice(end, end + anchor.suffix.length);
  const suffixOk =
    anchor.suffix === "" || suffixShown === anchor.suffix.slice(0, suffixShown.length);
  return prefixOk && suffixOk;
};

/** 多处命中取"离写入时 `start` 最近"的一处；并列时取靠前的（确定性）。 */
const closestOf = (candidates: readonly number[], start: number): number =>
  candidates.reduce((best, at) => (Math.abs(at - start) < Math.abs(best - start) ? at : best));

/** 调用点已经保证 `list.length === 1`：`reduce` 无初值时返回唯一元素（不写 `?? 0` 默认值）。 */
const onlyOf = (list: readonly number[]): number => list.reduce((first) => first);

const needleOf = (anchor: TextAnchor): string => anchor.exact;

/**
 * 纯文本段内的锚点匹配：`exact` 有没有命中 → **唯一命中直接采用**（不看上下文）→
 * 多处命中才用 `prefix`/`suffix` 消歧 → 仍多命中取最接近 `start` 的；一个都不合上下文 = `ambiguous`。
 * 与 `resolveAnchor` 的区别只在少了"块还在吗"那一层——侧车批注的文本域由调用方决定（选择器命中元素或 body 兜底）。
 */
export const matchAnchorInText = (text: string, anchor: TextAnchor): AnchorResult => {
  const needle = needleOf(anchor);
  const starts = occurrenceStarts(text, needle);
  if (starts.length === 0) return { ok: false, reason: "anchor_lost" };
  if (starts.length === 1) {
    const only = onlyOf(starts);
    return { ok: true, start: only, end: only + needle.length };
  }
  const fitting = starts.filter((at) => fitsContext(text, at, anchor));
  if (fitting.length === 0) return { ok: false, reason: "ambiguous" };
  const start = closestOf(fitting, anchor.start);
  return { ok: true, start, end: start + needle.length };
};

/**
 * 解析顺序：块还在吗 → `exact` 有没有命中 → **唯一命中直接采用**（不看上下文）→
 * 多处命中才用 `prefix`/`suffix` 消歧 → 仍多命中取最接近 `start` 的；一个都不合上下文 = `ambiguous`。
 */
export const resolveAnchor = (annotation: Annotation, doc: AnchorDocument): AnchorResult => {
  if (!doc.nodeIds.includes(annotation.nodeId)) return { ok: false, reason: "orphaned" };
  return matchAnchorInText(doc.text, annotation.anchor);
};
