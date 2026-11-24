// 这层管：读入口共同的"这份文档现在能不能读"前置判定；不读盘、不建模型、不写盘。
//
// 两个判定要分开：缺 id 是一条命令能修好的状态（`hr normalize --write`），
// 没有 `<article>` 是这份文件本来就不是文档——混成一个码会让用户按提示跑了也修不好。

import {
  hasArticle,
  type HtmlElementNode,
  type HtmlNode,
  injectNodeIds,
  type ParsedHtml,
  HrError,
} from "@hreader/core";

/**
 * 重复 `data-hr-id` 在加载侧就要拒：定位按 id 取值，重复的那两处**一处也定位不到**（不是“命中第一个”），
 * 所以 `read`/`patch` 在进定位之前就退出 2。
 * 与 `needs_normalize` 分开说：那是“缺 id”，这是“两个元素共用同一个 id”。
 */
const countHrId = (counts: Map<string, number>, element: HtmlElementNode): void => {
  for (const [name, value] of element.attrs) {
    if (name === "data-hr-id") counts.set(value, (counts.get(value) ?? 0) + 1);
  }
};

const hrIdCounts = (root: HtmlNode): Map<string, number> => {
  const counts = new Map<string, number>();
  const stack: HtmlNode[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.kind === "element") countHrId(counts, node);
    if (node.kind === "element" || node.kind === "document") stack.push(...node.children);
  }
  return counts;
};

export const assertUniqueIds = (parsed: ParsedHtml, file: string): void => {
  for (const [id, count] of hrIdCounts(parsed.root)) {
    if (count < 2) continue;
    throw new HrError(
      "duplicate_id",
      `${file} 里有两个元素共用 data-hr-id "${id}"（第 2 处，共 ${String(count)} 处）：重复的那处永远读不到、也改不到删不掉。先跑 hr normalize ${file} --write，重复的那个会被改名`,
    );
  }
};

/** 注入会产出新 id ⇔ 盘上缺 id；用注入结果当判据，不另立一套“什么算缺”。 */
const needsNormalize = (parsed: ParsedHtml): boolean => injectNodeIds(parsed).injected.length > 0;

export const assertIsDocument = (parsed: ParsedHtml, file: string): void => {
  if (!hasArticle(parsed)) {
    throw new HrError("no_article", `${file} 里没有 <article>：这不是一篇 hReader 文档`);
  }
};

/**
 * 缺 id 时直接失败而不是临时注入：算出来的 id 不在盘上，用户把它喂回 `patch` 必挂。
 */
export const assertNormalized = (parsed: ParsedHtml, file: string): void => {
  if (needsNormalize(parsed)) {
    throw new HrError(
      "needs_normalize",
      `${file} 缺少 data-hr-id，先跑 hr normalize ${file} --write`,
    );
  }
};

/**
 * core 不知道文件名（它手上只有模型），报"缺 id"时只能泛指。有路径的那一层用它把文件名与
 * 可直接粘贴的命令补上，别让用户对着 `<file>` 猜。
 */
export const withNormalizeAdvice = (error: unknown, file: string): unknown =>
  error instanceof HrError && error.code === "needs_normalize"
    ? new HrError("needs_normalize", `${file} 缺少 data-hr-id，先跑 hr normalize ${file} --write`)
    : error;
