// 这层管：文档里有没有 `<article>`（"这是不是一篇文档"的最小判据）；不建模型、不改入参。

import { ARTICLE_TAG, type HtmlNode, type ParsedHtml } from "./constants";
import { drainStack } from "./stack";

/**
 * 只看标签，不看 id 也不看结构：`<article>` 在但缺 `data-hr-id` 与"根本不是文档"是两件事，
 * 前者一条命令能修（`hr normalize`），后者修不了。
 */
export const hasArticle = (parsed: ParsedHtml): boolean => {
  const stack: HtmlNode[] = [parsed.root];
  for (const current of drainStack(stack)) {
    if (current.kind === "element" && current.tag === ARTICLE_TAG) return true;
    if (current.kind === "element" || current.kind === "document") {
      for (const child of current.children) stack.push(child);
    }
  }
  return false;
};
