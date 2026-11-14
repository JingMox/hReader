// 这层管：**没有 meta 脚本时插到哪**（裁定 #17）——优先 `<article>` 末尾，其次 `<body>` 末尾，都没有就追加。
// 全部用解析器的 span 定位：正文里的字面 `</body>` 文本节点不会影响插入点（P1-6）。
// 只做纯字符串拼接；"插什么 script"由调用方（store 的完整 meta / server 的首条批注）决定。

import { type HtmlElementNode, type HtmlNode } from "../html/constants";
import { parseHtml } from "../html/parse";
import { spanOf } from "../html/span";

/** 解析树里的元素，文档顺序（数组迭代器按下标走，循环中 `push` 的子节点会被同一轮访问到）。 */
export const elementsOf = (root: HtmlNode): readonly HtmlElementNode[] => {
  const out: HtmlElementNode[] = [];
  const stack: HtmlNode[] = [root];
  for (const current of stack) {
    if (current.kind === "element") out.push(current);
    if (current.kind === "document" || current.kind === "element") {
      for (const child of current.children) stack.push(child);
    }
  }
  return out;
};

/**
 * 把完整的 `<script id="hr-meta">…</script>` 片段插到定位点：`article`/`body` 的 `innerEnd`。
 * 合成节点（片段输入的 `body`）区间是零宽的——`end <= start` 时退回"追加到末尾"，否则会插到文首。
 */
export const insertMeta = (html: string, script: string): string => {
  const parsed = parseHtml(html, { locations: true });
  const elements = elementsOf(parsed.root);
  const anchor =
    elements.filter((element) => element.tag === "article").at(-1) ??
    elements.filter((element) => element.tag === "body").at(-1);
  const span = spanOf(anchor);
  if (span === null || span.end <= span.start) return html + script;
  return `${html.slice(0, span.innerEnd)}${script}${html.slice(span.innerEnd)}`;
};
