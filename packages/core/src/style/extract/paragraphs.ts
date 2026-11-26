// 这层管：语料 → 纯文字段落 → 句数（Markdown 行块与 HTML 块元素两套切分）；不统计、不判定风格。

import { injectNodeIds, parseHtml } from "../../html";
import type { HtmlNode, ParsedHtml } from "../../html";
import { toDocumentModel } from "../../model";
import type { DocumentModel } from "../../model";

import type { CorpusText } from "./contracts";

/**
 * HTML 侧算"叙述正文"的块元素：标题、代码、表格与 Markdown 侧同口径排除。
 * 只列 `BLOCK_TAGS` 里的标签——不在那里的元素永不成为模型节点，列进来是死条目。
 */
const PARAGRAPH_TAGS: ReadonlySet<string> = new Set(["p", "li", "blockquote"]);

const ASCII_ALNUM = /[0-9A-Za-z]/u;

const SPACE = /\s/u;

const FENCE = /^\s*(?:```|~~~)/u;

const HEADING = /^\s*#{1,6}\s/u;

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/u;

const QUOTE_MARKER = /^\s*>\s?/u;

const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/u;

const TABLE_ROW = /^\s*\|/u;

const HTML_TAG_LINE = /^\s*<\/?[A-Za-z][^>]*>\s*$/u;

const REFERENCE_DEFINITION = /^\s*\[[^\]]+\]:/u;

const FRONT_MATTER = /^---$/u;

/** 两行软换行拼接：只有两侧都是 ASCII 字母数字时才补空格，中文软换行不该被撑开。 */
const needsSpace = (left: string, right: string): boolean => {
  const last = left.charAt(left.length - 1);
  const first = right.charAt(0);
  return ASCII_ALNUM.test(last) && ASCII_ALNUM.test(first);
};

const joinSoft = (lines: readonly string[]): string =>
  lines.reduce(
    (acc, line) => (acc === "" ? line : `${acc}${needsSpace(acc, line) ? " " : ""}${line}`),
    "",
  );

/** 去掉列表/引用标记：它们各自成段，但标记本身不算正文。 */
const stripMarker = (line: string): string =>
  line.replace(LIST_MARKER, "").replace(QUOTE_MARKER, "");

/** 结构性行（标题/表格/分隔线/整行 HTML 标签/链接定义）不进正文段落。 */
const isStructuralLine = (line: string): boolean =>
  HEADING.test(line) ||
  HORIZONTAL_RULE.test(line) ||
  TABLE_ROW.test(line) ||
  HTML_TAG_LINE.test(line) ||
  REFERENCE_DEFINITION.test(line);

/** 只有首个非空行是 `---` 时才按 front matter 跳过：正文里的 `---` 是分隔线，不是块首。 */
const frontMatterEnd = (lines: readonly string[]): number => {
  let opening = -1;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    opening = FRONT_MATTER.test(line.trim()) ? index : -1;
    break;
  }
  if (opening === -1) return 0;
  for (const [index, line] of lines.entries()) {
    if (index > opening && FRONT_MATTER.test(line.trim())) return index + 1;
  }
  return 0;
};

/** @internal 仅供统计层的边界测试直接驱动行级切分；对外入口是 `paragraphTextsOf`。 */
export const markdownParagraphsOf = (text: string): readonly string[] => {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = (): void => {
    if (current.length > 0) paragraphs.push(joinSoft(current));
    current = [];
  };
  for (const line of lines.slice(frontMatterEnd(lines))) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "" || isStructuralLine(line)) {
      flush();
      continue;
    }
    const stripped = stripMarker(line);
    if (stripped !== line) flush();
    current.push(stripped);
  }
  flush();
  return paragraphs;
};

const paragraphsOfModel = (node: DocumentModel): readonly string[] => [
  ...(PARAGRAPH_TAGS.has(node.tag) && node.text.trim() !== "" ? [node.text] : []),
  ...node.children.flatMap(paragraphsOfModel),
];

const ARTICLE = "article";

const childrenOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "element" || node.kind === "document" ? node.children : [];

const hasArticle = (node: HtmlNode): boolean =>
  (node.kind === "element" && node.tag === ARTICLE) || childrenOf(node).some(hasArticle);

/**
 * 另存下来的网页大多没有 `<article>`，而模型派生要求恰好一个。
 * 只在这里补一层空壳：改阅读器的派生语义会让真实文档的 `invalid_document` 失去意义。
 */
const withArticle = (parsed: ParsedHtml): ParsedHtml =>
  hasArticle(parsed.root)
    ? parsed
    : {
        ...parsed,
        root: { kind: "element", tag: ARTICLE, attrs: [], children: childrenOf(parsed.root) },
      };

/**
 * 文档模型只把带 `data-hr-id` 的块级元素算作节点，其余文本会被吸进最近的祖先：
 * 用户给的 HTML 语料通常没有 id，所以先注入——补全缺失 id；不合法 id 被改写并追加
 * `invalid_hr_id` 诊断；文本节点原样透传。
 */
const htmlParagraphsOf = (text: string): readonly string[] =>
  paragraphsOfModel(toDocumentModel(injectNodeIds(withArticle(parseHtml(text))).parsed));

export const paragraphTextsOf = (corpus: readonly CorpusText[]): readonly string[] =>
  corpus
    .flatMap((one) =>
      one.format === "markdown" ? markdownParagraphsOf(one.text) : htmlParagraphsOf(one.text),
    )
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");

const TERMINATORS = "。！？!?…";

/** ASCII 句点只在"后面是空白或行尾"时算句末：`3.5`、`v1.0.1` 不是两句。 */
const isAsciiPeriodEnd = (text: string, index: number): boolean => {
  if (text.charAt(index) !== ".") return false;
  const next = text.charAt(index + 1);
  return next === "" || SPACE.test(next);
};

/** 分号不算句末：`；` 连的是小句，`。！？!?…` 与行尾句点才结束一句。
 *
 * @internal 仅供统计层与边界测试使用；对外只经 `statisticsOf` 露出汇总量。
 */
export const sentenceCountOf = (text: string): number => {
  let count = 0;
  let previousTerminator = false;
  for (let index = 0; index < text.length; index += 1) {
    const terminal = TERMINATORS.includes(text.charAt(index)) || isAsciiPeriodEnd(text, index);
    if (!terminal) {
      previousTerminator = false;
      continue;
    }
    // 连写的"？！"/"……"只算一次：它们还收在同一个句尾。
    if (!previousTerminator) count += 1;
    previousTerminator = true;
  }
  if (count > 0) return count;
  return text.trim() === "" ? 0 : 1;
};
