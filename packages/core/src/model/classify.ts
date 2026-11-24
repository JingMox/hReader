// 这层管：把 ParsedHtml 分三档（托管 / 可归一 / 外来）；不派生模型、不抛异常。

import {
  ARTICLE_TAG,
  type HtmlElementNode,
  type HtmlNode,
  type ParsedHtml,
} from "../html/constants";
import { drainStack } from "../html/stack";
import { validIdOf } from "./attrs";

export type DocClass = "managed" | "normalizable" | "foreign";

export interface Classification {
  readonly cls: DocClass;
  readonly articles: number;
  /** `foreign` 时给人话原因，可直接进 UI 横幅。 */
  readonly reason?: string;
}

const articleNodesOf = (root: HtmlNode): readonly HtmlElementNode[] => {
  const found: HtmlElementNode[] = [];
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind === "element" && node.tag === ARTICLE_TAG) found.push(node);
    if (node.kind === "element" || node.kind === "document") {
      for (const child of node.children) stack.push(child);
    }
  }
  return found;
};

/**
 * 分档判据与 `toDocumentModel` 的抛错点一一对应：
 * - 0 个或多于 1 个 `<article>` → foreign（多 article 是合法 HTML，不是损坏，不报错）；
 * - 恰好 1 个但 `data-hr-id` 不合法 → normalizable（`hr normalize --write` 能修）；
 * - 恰好 1 个且 id 合法 → managed（derive 必成功）。
 * 多个 `<article>` 时不存在"哪个算正文"，不给其中任何一个记 kind/id。
 */
export const classifyDocument = (parsed: ParsedHtml): Classification => {
  const articles = articleNodesOf(parsed.root);
  const single = articles.length === 1 ? articles[0] : undefined;
  if (single === undefined) {
    return {
      cls: "foreign",
      articles: articles.length,
      reason:
        articles.length === 0
          ? `文档里没有 <${ARTICLE_TAG}>：按外来 HTML 原样展示，不能按块编辑`
          : `文档里有 ${String(articles.length)} 个 <${ARTICLE_TAG}>：按外来 HTML 原样展示，不能按块编辑`,
    };
  }
  return validIdOf(single) === ""
    ? { cls: "normalizable", articles: 1 }
    : { cls: "managed", articles: 1 };
};
