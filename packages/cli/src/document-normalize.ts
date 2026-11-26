// This layer: the shared "can this document be read now" preflight for read entries; no disk reads, no model building, no writes.
//
// The two checks stay separate: missing ids are a state one command can fix (`hr normalize --write`),
// while no `<article>` means the file simply is not a document — merging them into one code would send users down a fix that cannot work.

import {
  hasArticle,
  type HtmlElementNode,
  type HtmlNode,
  injectNodeIds,
  type ParsedHtml,
  HrError,
} from "@hreader/core";

/**
 * Duplicate `data-hr-id`s are refused at load time: location resolves by id, and **neither** duplicate can be
 * located (not "first match wins"), so `read`/`patch` exit 2 before location is attempted.
 * Kept separate from `needs_normalize`: that one means "ids are missing", this one means "two elements share one id".
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

/** Injection produces new ids <=> ids are missing on disk; the injection result is the criterion — no second definition of "missing". */
const needsNormalize = (parsed: ParsedHtml): boolean => injectNodeIds(parsed).injected.length > 0;

export const assertIsDocument = (parsed: ParsedHtml, file: string): void => {
  if (!hasArticle(parsed)) {
    throw new HrError("no_article", `${file} 里没有 <article>：这不是一篇 hReader 文档`);
  }
};

/**
 * Fail outright when ids are missing instead of injecting ad hoc: computed ids are not on disk, and feeding one back to `patch` fails.
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
 * core does not know the file name (it only holds the model), so its "missing ids" error can only be generic.
 * The layer with the path uses it to fill in the file name and a paste-ready command — do not make the user guess at `<file>`.
 */
export const withNormalizeAdvice = (error: unknown, file: string): unknown =>
  error instanceof HrError && error.code === "needs_normalize"
    ? new HrError("needs_normalize", `${file} 缺少 data-hr-id，先跑 hr normalize ${file} --write`)
    : error;
