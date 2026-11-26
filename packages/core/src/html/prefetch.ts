// 这层管：联网关时从**下发字节**里精确摘掉 `<link rel="dns-prefetch|preconnect|prefetch|
// prerender|modulepreload">` 这类预取/预连接提示——CSP 管不到资源提示，它们照样让
// 外来文档向外部主机发出 DNS/TCP 探测。删的是字符串区间（parse5 源码位置），不是序列化，
// 落盘文件一个字节不动。

import { attributeOf } from "../model/attrs";
import type { HtmlElementNode, HtmlNode } from "./constants";
import { parseHtml } from "./parse";
import { spanOf } from "./span";
import { drainStack } from "./stack";

const PREFETCH_RELS: ReadonlySet<string> = new Set([
  "dns-prefetch",
  "preconnect",
  "prefetch",
  "prerender",
  "modulepreload",
]);

/**
 * `<link>` 的 `rel` 是空格分隔 token 列表（大小写不敏感）：命中任一会话 token 即删整元素。
 * 反向白名单（只删"整 rel 都预取"的）会漏 `rel="preconnect stylesheet"` 这种混合写法。
 */
const hasPrefetchRel = (node: HtmlElementNode): boolean => {
  if (node.tag !== "link") return false;
  const rel = attributeOf(node, "rel");
  if (rel === undefined) return false;
  for (const token of rel.toLowerCase().split(/\s+/u)) {
    if (PREFETCH_RELS.has(token)) return true;
  }
  return false;
};

const prefetchSpansOf = (root: HtmlNode): readonly { start: number; end: number }[] => {
  const spans: { start: number; end: number }[] = [];
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind === "element" || node.kind === "document") {
      if (node.kind === "element" && hasPrefetchRel(node)) {
        const span = spanOf(node);
        if (span.end > span.start) spans.push({ start: span.start, end: span.end });
        // <link> 是 void 元素不会有子树，但删掉后其子节点位置已失效，不必再下去。
        continue;
      }
      for (const child of node.children) stack.push(child);
    }
  }
  return spans;
};

/**
 * 返回去掉全部预取 `<link>` 后的 HTML；没有命中时原样返回（同一字符串，调用方可复用）。
 * 从后往前删区间：先删后面的，前面的 offset 不失效。
 */
export const stripPrefetchLinks = (html: string): string => {
  const { root } = parseHtml(html, { locations: true });
  const spans = prefetchSpansOf(root);
  if (spans.length === 0) return html;
  let out = html;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  return out;
};
