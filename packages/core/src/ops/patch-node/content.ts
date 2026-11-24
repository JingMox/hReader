// 这层管：内容模型判定（块级片段能不能成为某个容器的子节点）；不定位、不解析、不碰 IO。

import type { HtmlElementNode, HtmlNode } from "../../html/constants";
import { HrError } from "../../hr-error";

/**
 * phrasing 内容白名单：**只判片段自身是不是行内内容**（能不能落进行内内容的容器），
 * 不表示容器语义——容器能不能装块级内容分别由 `INLINE_ONLY_CONTAINERS` / `RAW_TEXT_CONTAINERS` /
 * `FORBIDDEN_CHILDREN` 判。列表是 HTML 规范的 phrasing content（`select`/`textarea` 本身是行内内容，
 * 作为片段合法；它们作为**容器**的特殊语义另判）。
 */
const PHRASING_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "audio",
  "b",
  "bdi",
  "bdo",
  "br",
  "button",
  "canvas",
  "cite",
  "code",
  "data",
  "datalist",
  "del",
  "dfn",
  "em",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "map",
  "mark",
  "math",
  "meter",
  "object",
  "output",
  "picture",
  "progress",
  "q",
  "ruby",
  "s",
  "samp",
  "select",
  "slot",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "svg",
  "template",
  "textarea",
  "time",
  "u",
  "var",
  "video",
  "wbr",
]);

/**
 * 内容模型是 phrasing 的容器：块级子节点要么被解析器拆树（`p`：遇块级先闭合，块级变成兄弟），
 * 要么只是内容模型不合规、树本身不变（`pre`：解析器不重排）。
 * `dt` 按规范能装 flow（R1-F11 移出本表），`p`/`pre` 才是真的只装 phrasing。
 */
const INLINE_ONLY_CONTAINERS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "legend",
]);

/** 子节点会被当**字面文本**处理的容器：写出去的 `<b>` 解析回来只是一段文本，写盘即失真，一律拒绝。 */
const RAW_TEXT_CONTAINERS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

/**
 * 只装固定几类子节点的结构容器：换成别的标签，解析器会丢弃/重排，或把树改成别的形状。
 * - `select`：只装 `option`/`optgroup`；
 * - `table`：只装表格结构元素；其余内容（`p`/`div`/`ul`/`li`/`form`/`h1…`）在 in-table 模式会被
 *   foster-parent 移到表格之前，`<table>` 里就不再有它——默认拒绝，不靠事后解析比较补救；
 *   `tr`/`td`/`th` 留在本表里是为了让 `FORBIDDEN_CHILDREN` 的专项报文拒（直接挂 `<table>` 下会多插 `<tbody>`）；
 * - `tr`：只装单元格 `td`/`th`（放别的会被 foster-parent 移出表格）；
 * - `thead`/`tbody`/`tfoot`：只装 `tr`；
 * - `dl`：只装 `dt`/`dd`/`div`（HTML5 允许 `div` 分组，解析器不重排）。
 * `td`/`th`/`div`/`aside`/`nav`/`main`/`article`/`figcaption`/`caption` 装 flow，无单独条目。
 */
const ONLY_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  select: new Set(["option", "optgroup"]),
  table: new Set(["caption", "colgroup", "tr", "td", "th", "thead", "tbody", "tfoot"]),
  tr: new Set(["td", "th"]),
  thead: new Set(["tr"]),
  tbody: new Set(["tr"]),
  tfoot: new Set(["tr"]),
  dl: new Set(["dt", "dd", "div"]),
};

/**
 * 会**把子节点挪走/拆成兄弟**的容器→子标签组合：这些才是写盘后解析器真的会改树的组合，命中即拒绝。
 * `<ul><p>`、`<dl><p>` 这类只是内容模型不合规、树不变的组合**不登记**（审计裁定边界）。
 * `<table>` 里能放什么由 `ONLY_CHILDREN.table` 反面收（foster parenting 对任何非表格内容都生效，
 * 列“禁止项”永远列不全）；本表只留直接挂 `<table>` 下会多插 `<tbody>`/`<colgroup>` 的那几个。
 * 每个键为什么改树：
 * - `li`：`<li>` 遇新的 `<li>` 自动闭合，第二个变成**兄弟**而非子节点；
 * - `table`：表格结构元素只在表格上下文成立，错位的行/单元格会被自动包 `<tbody>` 或被 foster-parent 移出表格；
 * - `dd`/`dt`：定义列表里 `<dd>`/`<dt>` 互相自动闭合，后一个变成兄弟；
 * - `a`：嵌套 `<a>` 触发"收养代理算法"，内层被提到兄弟层；
 * - `button`：`<button>` 内再开 `<button>` 会先弹出外层，内层成兄弟；
 * - `form`：嵌套 `<form>` 被解析器忽略，内层表单直接消失；
 * - `label`：嵌套 `<label>` 属内容模型违规（解析器不拆树，按审计要求登记，避免无意义的自嵌套）；
 * - `option`：`<option>` 内再开 `<option>` 会先闭合外层，成兄弟。
 */
const FORBIDDEN_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  li: new Set(["li"]),
  table: new Set(["tr", "td", "th"]),
  dd: new Set(["dd", "dt"]),
  dt: new Set(["dd", "dt"]),
  a: new Set(["a"]),
  button: new Set(["button"]),
  form: new Set(["form"]),
  label: new Set(["label"]),
  option: new Set(["option"]),
};

/**
 * 表格结构元素只能在表格上下文里出现：写进别的容器，解析回来标签会被丢掉或 foster-parent 移走
 * （`<div><tr>` 写盘后 `<tr>` 不再是 div 的子节点）。允许的父容器就这几个，其余一律在写盘前拒绝。
 */
const TABLE_STRUCTURE_TAGS: ReadonlySet<string> = new Set([
  "caption",
  "col",
  "colgroup",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);

const TABLE_STRUCTURE_PARENTS: ReadonlySet<string> = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
]);

const CONTAINER_WORDS: Readonly<Record<string, string>> = {
  p: "段落（只装行内内容）",
  pre: "预排版块（只装行内内容）",
};

/** 兜底故意笼统：这里只回答"这是只装行内内容的容器"这一类，不承诺具体标签名（具体那几个见 `CONTAINER_WORDS`）。 */
const containerWordOf = (tag: string): string =>
  CONTAINER_WORDS[tag] ?? (/^h[1-6]$/u.test(tag) ? "标题（只装行内内容）" : "行内内容容器");

/** 候选容器名（`<a>/<b>` 这种）：报文本想把允许的子标签列给用户。 */
const tagListOf = (tags: ReadonlySet<string>): string =>
  [...tags].map((tag) => `<${tag}>`).join("/");

const conflict = (message: string): never => {
  throw new HrError("content_model_conflict", message);
};

/** ① 原始文本容器：子元素写出去解析回来只是字面文本。 */
const assertNotRawText = (containerTag: string, tag: string): void => {
  if (!RAW_TEXT_CONTAINERS.has(containerTag)) return;
  conflict(
    `目标 <${containerTag}> 的内容按字面文本处理，装不下子元素 <${tag}>：` +
      `写出去的 <${tag}> 解析回来只是一段文本，而不是元素`,
  );
};

/** ② 只装固定几类子节点的结构容器（`ONLY_CHILDREN`）。 */
const assertOnlyChildren = (containerTag: string, tag: string): void => {
  const onlyChildren = ONLY_CHILDREN[containerTag];
  if (onlyChildren === undefined || onlyChildren.has(tag)) return;
  // 表格是最容易被“静默重排”的那一类：非表格内容会被 foster-parent 移到 `<table>` 之前。
  const why =
    containerTag === "table"
      ? "；<table> 里的非表格内容会被 foster-parent 移到表格之前，写出去解析回来不在同一位置"
      : `；要加内容请 append 到能真正容纳 <${tag}> 的容器`;
  conflict(`目标 <${containerTag}> 只装 ${tagListOf(onlyChildren)}，装不下 <${tag}>${why}`);
};

/** ③ 表格结构元素只能在表格上下文里出现：写进别的容器，解析回来会换父节点。 */
const assertTableStructureInsideTable = (containerTag: string, tag: string): void => {
  if (!TABLE_STRUCTURE_TAGS.has(tag) || TABLE_STRUCTURE_PARENTS.has(containerTag)) return;
  conflict(
    `目标 <${containerTag}> 装不下表格结构元素 <${tag}>：它只在 <table> 上下文里成立，` +
      `写出去解析回来不再是 <${containerTag}> 的子节点；请改到 <table>/<tbody>/<tr> 上追加`,
  );
};

/** ④ 解析器会改树的组合（`FORBIDDEN_CHILDREN`）：兄弟化、foster-parent、被忽略。 */
const assertNotRestructuring = (containerTag: string, tag: string): void => {
  if (FORBIDDEN_CHILDREN[containerTag]?.has(tag) !== true) return;
  conflict(
    `目标 <${containerTag}> 装不下子节点 <${tag}>：HTML 解析器会改结构` +
      `（<${containerTag}> 里再放 <${tag}> 会被解析成兄弟或被移出容器，而不是子节点），` +
      `写出去的字节与解析回来的树不一致。请改 append 到一个能真正容纳 <${tag}> 的容器`,
  );
};

/** ⑤ 只装行内内容的容器遇到块级片段。 */
const assertPhrasingOnly = (container: HtmlElementNode, tag: string): void => {
  if (!INLINE_ONLY_CONTAINERS.has(container.tag) || PHRASING_TAGS.has(tag)) return;
  conflict(
    `目标 <${container.tag}> 是${containerWordOf(container.tag)}，装不下子节点 <${tag}>；` +
      "要插段落请选容器元素，如 article/section/div",
  );
};

/**
 * 写盘前就拒绝"写出去解析回来不是同一棵树"的组合，判定只看内容模型，不看目标叫什么、也不靠事后
 * "解析回来比较"补救。五类拒绝理由分开写，报文各自点明下一步：
 * ① 原始文本容器；② 只装固定几类子节点的结构容器（`ONLY_CHILDREN`）；③ 表格结构元素写到表格外；
 * ④ 解析器会改树（`FORBIDDEN_CHILDREN`）；⑤ 只装行内内容的容器遇到块级片段。
 */
export const assertFragmentFits = (container: HtmlElementNode, fragment: HtmlNode): void => {
  // `parseFragment` 只回单元素；非元素在这里没有"内容模型"可言，跳过（片段合法性已由 `parseFragment` 拒绝过）。
  if (fragment.kind !== "element") return;
  assertNotRawText(container.tag, fragment.tag);
  assertOnlyChildren(container.tag, fragment.tag);
  assertTableStructureInsideTable(container.tag, fragment.tag);
  assertNotRestructuring(container.tag, fragment.tag);
  assertPhrasingOnly(container, fragment.tag);
};
