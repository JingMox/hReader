// 这层管：文档形态（笔记 / 报告 / 纪要 / 简报 / 幻灯片）与各自的起稿骨架；只产出 HTML 文本，不落盘。

import { injectNodeIds } from "../html/inject";
import { parseHtml } from "../html/parse";
import { serializeHtml } from "../html/serialize";

export const DOC_KINDS = ["note", "report", "minutes", "brief", "slides"] as const;

export type DocKind = (typeof DOC_KINDS)[number];

export const DEFAULT_DOC_KIND: DocKind = "note";

/** 形态写在 `<article>` 上：主题按它分叉（幻灯片一节一屏），Agent 读大纲前也能知道这是什么文档。 */
export const KIND_ATTRIBUTE = "data-hr-kind";

const KIND_NAMES: readonly string[] = DOC_KINDS;

export const isDocKind = (value: string): value is DocKind => KIND_NAMES.includes(value);

export interface NewDocumentInput {
  readonly kind: DocKind;
  /** 纯文本标题（写进 `<title>` 与 `<h1>`，这里负责转义）。 */
  readonly title: string;
}

const section = (heading: string, ...blocks: readonly string[]): string =>
  ["<section>", `<h2>${heading}</h2>`, ...blocks, "</section>"].join("\n");

const cell = (head: string, body: string): string =>
  `<div><p><strong>${head}</strong></p><p>${body}</p></div>`;

const KPI = [
  '<div data-hr-component="kpi-bento">',
  cell("（数字 1）", "（口径说明）"),
  cell("（数字 2）", "（口径说明）"),
  cell("（数字 3）", "（口径说明）"),
  "</div>",
].join("\n");

const COMPARE = [
  '<div data-hr-component="split-compare">',
  cell("（方案 A）", "（优势与代价）"),
  cell("（方案 B）", "（优势与代价）"),
  "</div>",
].join("\n");

const TIMELINE = [
  '<ol data-hr-component="step-timeline">',
  "<li><p><strong>（第一步）</strong></p><p>（负责人 · 截止时间）</p></li>",
  "<li><p><strong>（第二步）</strong></p><p>（负责人 · 截止时间）</p></li>",
  "</ol>",
].join("\n");

const insight = (text: string): string =>
  `<aside data-hr-component="callout-insight"><p>${text}</p></aside>`;

const warning = (text: string): string =>
  `<aside data-hr-component="callout-warning"><p>${text}</p></aside>`;

const TRANSCRIPT = [
  '<details data-hr-component="deep-dive">',
  "<summary>展开逐字稿</summary>",
  "<p>（有录音时改用 media-card 组件：音频 + 图注 + 可折叠逐字稿。）</p>",
  "</details>",
].join("\n");

const BODIES: Readonly<Record<DocKind, readonly string[]>> = {
  note: [section("要点", "<p>（先写一句结论，再展开。）</p>")],
  report: [
    section("结论", insight("（一句话结论：判断、证据、适用边界。）")),
    section("关键数据", KPI),
    section("分析", "<p>（展开论证：每个论断挂一个数字或来源。）</p>"),
    section("方案对比", COMPARE),
    section("风险", warning("（代价、坑、失败的前置条件。）")),
    section("下一步", TIMELINE),
  ],
  minutes: [
    section("结论与决定", insight("（这次会议定了什么。）")),
    section("讨论要点", "<p>（按议题记录：谁提了什么，依据是什么。）</p>"),
    section("待办", TIMELINE),
    section("录音与逐字稿", TRANSCRIPT),
  ],
  brief: [
    section("建议", insight("（做什么或不做什么，一句话。）")),
    section("依据", KPI),
    section("代价与风险", warning("（最坏情况与可回退的那一步。）")),
    section("下一步", TIMELINE),
  ],
  slides: [
    section("（这一页的结论）", "<p>（一页只讲一件事。）</p>"),
    section("关键数字", KPI),
    section("方案对比", COMPARE),
    section("下一步", TIMELINE),
  ],
};

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const articleOf = (kind: DocKind, title: string): string =>
  [
    `<article data-hr-id="root" ${KIND_ATTRIBUTE}="${kind}">`,
    `<h1>${title}</h1>`,
    ...BODIES[kind],
    "</article>",
  ].join("\n");

/** 幻灯片要占满视口，不进 68ch 的阅读版心；其余形态与示例库一样包一层 `.hr-layout` 居中。 */
const bodyOf = (kind: DocKind, article: string): string =>
  kind === "slides" ? article : `<main class="hr-layout">\n${article}\n</main>`;

const skeletonOf = (kind: DocKind, title: string): string => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body>
${bodyOf(kind, articleOf(kind, title))}
</body>
</html>
`;

/** 骨架里只手写 `<article data-hr-id="root">`，其余 id 交给 `injectNodeIds`（与 normalize 同一口径）。 */
export const newDocumentHtml = (input: NewDocumentInput): string =>
  serializeHtml(injectNodeIds(parseHtml(skeletonOf(input.kind, escapeText(input.title)))).parsed);
