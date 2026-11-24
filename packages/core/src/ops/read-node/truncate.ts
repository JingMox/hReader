// 这层管：按字节上限在元素边界截断序列化结果（补齐闭合标签、按码点切）；不改树、不判可见性。

import { HrError } from "../../hr-error";
import { type HtmlElementNode, type HtmlNode, VOID_TAGS } from "../../html/constants";
import { serializeHtml } from "../../html/serialize";

const encoder = new TextEncoder();

/** 只编一次、只量一次：成本与输出字节数同阶，不做“整串反复算长度”。 */
const utf8Length = (text: string): number => encoder.encode(text).length;

interface Fitted {
  readonly html: string;
  readonly truncated: boolean;
  /** 完整进入输出的节点数（正文文本被切一半的文本节点也算）。 */
  readonly keptNodes: number;
  /** 完整序列化的字节数，与输出无关，只作诊断。 */
  readonly originalBytes: number;
}

const serializeNode = (node: HtmlNode): string => serializeHtml({ root: node, diagnostics: [] });

const shallowOf = (node: HtmlElementNode): HtmlElementNode => ({
  kind: "element",
  tag: node.tag,
  attrs: node.attrs,
  children: [],
});

/** 开标签复用序列化器（转义规则只有一份）：空子树结果去掉闭合标签即是开标签。 */
const startTagOf = (node: HtmlElementNode): string => {
  const text = serializeNode(shallowOf(node));
  return VOID_TAGS.has(node.tag) ? text : text.slice(0, text.length - (node.tag.length + 3));
};

type Task =
  | { readonly kind: "open"; readonly node: HtmlElementNode }
  | { readonly kind: "close"; readonly text: string }
  | { readonly kind: "leaf"; readonly node: HtmlNode };

interface Emitter {
  readonly chunks: string[];
  used: number;
  /** 已排队但还没写出的闭合标签字节：留着位置，免得它们把输出顶出上限。 */
  reserved: number;
}

const fits = (emitter: Emitter, text: string, limit: number): boolean => {
  const size = utf8Length(text);
  if (emitter.used + size + emitter.reserved > limit) {
    return false;
  }
  emitter.chunks.push(text);
  emitter.used += size;
  return true;
};

/** 文本装不下时取码点前缀：二分探测，代理对与组合字符都不会被切开；同时返回字节数。 */
const prefixThatFits = (value: string, budget: number): { text: string; bytes: number } => {
  const units = Array.from(value);
  let low = 0;
  let high = units.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = serializeNode({ kind: "text", value: units.slice(0, middle).join("") });
    if (utf8Length(candidate) <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const serialized = serializeNode({ kind: "text", value: units.slice(0, low).join("") });
  return { text: serialized, bytes: utf8Length(serialized) };
};

/** 元素子节点必须可再分：压成叶子会让大子树整块被判“装不下”而丢掉。 */
const loadChildren = (source: readonly HtmlNode[], tasks: Task[]): void => {
  for (const child of [...source].reverse()) {
    tasks.push(
      child.kind === "element" ? { kind: "open", node: child } : { kind: "leaf", node: child },
    );
  }
};

/** 元素的闭合标签先排队再写出：它占的字节要提前从预算里扣掉。 */
const queueClose = (node: HtmlElementNode, emitter: Emitter, tasks: Task[]): void => {
  const text = `</${node.tag}>`;
  emitter.reserved += utf8Length(text);
  tasks.push({ kind: "close", text });
};

const openElement = (
  node: HtmlElementNode,
  emitter: Emitter,
  tasks: Task[],
  limit: number,
): boolean => {
  if (!fits(emitter, startTagOf(node), limit)) {
    return false;
  }
  if (!VOID_TAGS.has(node.tag)) {
    queueClose(node, emitter, tasks);
    loadChildren(node.children, tasks);
  }
  return true;
};

/** 文本可以只取前缀（`partial` 也算截断）；注释/doctype 是原子单元，装不下就整个丢掉。 */
type LeafOutcome = "full" | "partial" | "none";

const openLeaf = (node: HtmlNode, emitter: Emitter, limit: number): LeafOutcome => {
  if (fits(emitter, serializeNode(node), limit)) {
    return "full";
  }
  if (node.kind !== "text") {
    return "none";
  }
  const budget = limit - emitter.used - emitter.reserved;
  const prefix = budget > 0 ? prefixThatFits(node.value, budget) : { text: "", bytes: 0 };
  if (prefix.text === "") {
    return "none";
  }
  emitter.chunks.push(prefix.text);
  emitter.used += prefix.bytes;
  return "partial";
};

const flushClose = (text: string, emitter: Emitter): void => {
  const size = utf8Length(text);
  emitter.reserved -= size;
  emitter.chunks.push(text);
  emitter.used += size;
};

/** 目标自身的最小可行字节数：开标签 + 闭合标签（void 元素只有开标签）。 */
const minimumBytes = (node: HtmlElementNode): number =>
  VOID_TAGS.has(node.tag)
    ? utf8Length(startTagOf(node))
    : utf8Length(startTagOf(node)) + utf8Length(`</${node.tag}>`);

const assertMinimum = (node: HtmlElementNode, limit: number): void => {
  const minimum = minimumBytes(node);
  if (limit < minimum) {
    throw new HrError(
      "invalid_max_bytes",
      `maxBytes 过小：<${node.tag}> 至少需要 ${String(minimum)} 字节，收到 ${String(limit)}`,
    );
  }
};

export const fitSubtree = (node: HtmlElementNode, limit: number): Fitted => {
  assertMinimum(node, limit);
  const originalBytes = utf8Length(serializeNode(node));
  const emitter: Emitter = { chunks: [], used: 0, reserved: 0 };
  const tasks: Task[] = [{ kind: "open", node }];
  let keptNodes = 0;
  let truncated = false;
  for (;;) {
    const task = tasks.pop();
    if (task === undefined) {
      break;
    }
    if (task.kind === "close") {
      flushClose(task.text, emitter);
      continue;
    }
    if (truncated) {
      continue;
    }
    if (task.kind === "open") {
      if (!openElement(task.node, emitter, tasks, limit)) {
        truncated = true;
        continue;
      }
      keptNodes += 1;
      continue;
    }
    const outcome = openLeaf(task.node, emitter, limit);
    if (outcome === "none") {
      truncated = true;
      continue;
    }
    keptNodes += 1;
    if (outcome === "partial") {
      truncated = true;
    }
  }
  return { html: emitter.chunks.join(""), truncated, keptNodes, originalBytes };
};
