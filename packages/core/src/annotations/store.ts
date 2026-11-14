// 这层管：`<script id="hr-meta">` 里 `annotations` 的读出/写回（AC2.1/AC2.4）；
// 纯函数：入字符串出字符串，不碰 IO、不读时钟。写回只做**源码区间拼接**，正文一个字节不动。

import { parseHtml } from "../html/parse";
import { spanOf } from "../html/span";
import type { HtmlElementNode, HtmlNode } from "../html/constants";
import { META_SCRIPT_ID } from "../html/constants";
import { attributeOf } from "../model/attrs";
import { insertMeta } from "./meta-insert";
import { parseAnnotationOf, unknownFieldsOf, type Annotation } from "./model";

export interface ReadResult {
  readonly annotations: readonly Annotation[];
  /** 每条都是**人话**诊断：调用方直接展示，不再自己拼（AC2.4）。 */
  readonly diagnostics: readonly string[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
};

const isMetaScript = (node: HtmlNode): node is HtmlElementNode =>
  node.kind === "element" && node.tag === "script" && attributeOf(node, "id") === META_SCRIPT_ID;

const childrenOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "element" || node.kind === "document" ? node.children : [];

const metaScriptOf = (root: HtmlNode): HtmlElementNode | undefined => {
  // 宽搜：script 只看 `id`（HTML 原生属性），与 `html/parse.ts` 同口径。
  const queue: HtmlNode[] = [root];
  while (queue.length > 0) {
    // `splice` 整批取出（不用 `shift()` + `undefined` 检查）：入队的永远是真节点。
    for (const node of queue.splice(0)) {
      if (isMetaScript(node)) return node;
      queue.push(...childrenOf(node));
    }
  }
  return undefined;
};

/** 脏 meta 的三种容错都在这里：不是 JSON / 不是对象 / `annotations` 不是数组 → 空 + 1 条诊断。 */
export const readAnnotations = (html: string): ReadResult => {
  const parsed = parseHtml(html, { locations: true });
  const script = metaScriptOf(parsed.root);
  const scriptSpan = spanOf(script);
  if (scriptSpan === null) return { annotations: [], diagnostics: [] };
  const payload = parseJson(html.slice(scriptSpan.innerStart, scriptSpan.innerEnd).trim());
  if (!isRecord(payload)) {
    return { annotations: [], diagnostics: ["hr-meta 不是合法 JSON 对象，按空批注处理"] };
  }
  const raw = payload["annotations"];
  if (!Array.isArray(raw)) {
    return { annotations: [], diagnostics: ["hr-meta.annotations 不是数组，按空批注处理"] };
  }
  const annotations: Annotation[] = [];
  const diagnostics: string[] = [];
  const unknown = new Set<string>();
  raw.forEach((item, index) => {
    for (const key of unknownFieldsOf(item)) unknown.add(key);
    const outcome = parseAnnotationOf(item, index);
    if (typeof outcome === "string") diagnostics.push(outcome);
    else {
      annotations.push(outcome.annotation);
      diagnostics.push(...outcome.diagnostics);
    }
  });
  if (unknown.size > 0) {
    // 只报一条：逐字段刷屏会把真正的错误淹掉（AC2.4）。
    diagnostics.push(`hr-meta 含未知字段：${[...unknown].join(", ")}（已忽略）`);
  }
  return { annotations, diagnostics };
};

const escapeJsonForScript = (json: string): string => json.replaceAll("</", "<\\/");

const annotationJson = (annotation: Annotation): string =>
  JSON.stringify({
    id: annotation.id,
    nodeId: annotation.nodeId,
    anchor: {
      exact: annotation.anchor.exact,
      prefix: annotation.anchor.prefix,
      suffix: annotation.anchor.suffix,
      start: annotation.anchor.start,
    },
    note: annotation.note,
    status: annotation.status,
    createdAt: annotation.createdAt,
    ...(annotation.resolvedAt === undefined ? {} : { resolvedAt: annotation.resolvedAt }),
    ...(annotation.resolutionNote === undefined
      ? {}
      : { resolutionNote: annotation.resolutionNote }),
  });

/** 固定字段序 + 不转义中文：同一份批注在两次写入里产生同一串字节（便于 diff/审计）。 */
const payloadOf = (annotations: readonly Annotation[]): string =>
  `{"version":1,"annotations":[${annotations.map(annotationJson).join(",")}]}`;

const scriptOf = (body: string): string =>
  `<script id="${META_SCRIPT_ID}" type="application/json">${escapeJsonForScript(body)}</script>`;

/**
 * 写回：有 meta 脚本就只替换它的**内容区间**，没有就交给 `insertMeta`（`</body>` 前的字面文本不算定位）。
 * 其余字节原样保留——AC2.5 的"正文不动"就靠这一点。
 */
export const writeAnnotations = (html: string, annotations: readonly Annotation[]): string => {
  const parsed = parseHtml(html, { locations: true });
  const script = metaScriptOf(parsed.root);
  const body = payloadOf(annotations);
  const scriptSpan = spanOf(script);
  if (scriptSpan === null || scriptSpan.end <= scriptSpan.start) {
    return insertMeta(html, scriptOf(body));
  }
  return (
    html.slice(0, scriptSpan.innerStart) +
    escapeJsonForScript(body) +
    html.slice(scriptSpan.innerEnd)
  );
};
