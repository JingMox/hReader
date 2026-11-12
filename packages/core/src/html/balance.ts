// 这层管：从原文统计未闭合与错嵌套（parse5 只报 tokenizer 级错误，树构造级错误不报）；不做修复。

import {
  type Diagnostic,
  type DiagnosticCode,
  DIAGNOSTIC_SEVERITY,
  RCDATA_TAGS,
  RAW_TEXT_TAGS,
  VOID_TAGS,
} from "./constants";

/** 结束标签可省的元素：EOF 时缺失属正常（HTML 允许），不能报未闭合。 */
const OPTIONAL_END_TAGS: ReadonlySet<string> = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
  "tfoot",
  "colgroup",
  "caption",
  "option",
  "optgroup",
  "html",
  "head",
  "body",
]);

/** 新起这些标签时，栈顶的对应元素会被浏览器事实关闭；静默 pop，不算错。 */
const BLOCK_STARTERS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "ul",
  "ol",
  "table",
  "section",
  "header",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "figure",
  "details",
  "article",
  "aside",
  "nav",
  "form",
  "hr",
  "dl",
  "address",
  "main",
  "fieldset",
]);

const CLOSED_BY: Readonly<Record<string, ReadonlySet<string>>> = {
  p: BLOCK_STARTERS,
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  tr: new Set(["tr"]),
  td: new Set(["td", "th", "tr"]),
  th: new Set(["td", "th", "tr"]),
  thead: new Set(["tbody", "tfoot"]),
  tbody: new Set(["tbody", "tfoot"]),
  tfoot: new Set(["tbody"]),
  option: new Set(["option", "optgroup"]),
  optgroup: new Set(["optgroup"]),
};

/**
 * 只保留"格式化元素"：外层结束标签收尾它们时，浏览器要做收养机构算法重建节点，
 * 结构真的被改写 → 报错嵌套。其余元素被祖先结束标签收尾属规范内的隐式闭合（`<ul><li>a</ul>`）。
 */
const FORMATTING_TAGS: ReadonlySet<string> = new Set([
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "tt",
  "u",
]);

/**
 * 树构造要求的最小父链（只表单元格三兄弟）：栈里的父不是合法父时，说明这些元素是解析器
 * 硬塞进去的（`<table><td>x</table>`），属真错嵌套，不能像 `<li>` 那样静默闭合。
 * `tr` 允许 `table` 父：`<table><tr>` 在源码层合法，合成 `tbody` 是解析器的事，不该报诊断。
 */
const LEGAL_PARENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  td: new Set(["tr"]),
  th: new Set(["tr"]),
  tr: new Set(["table", "tbody", "thead", "tfoot"]),
};

const RAW_TEXT_PATTERN = new RegExp(
  `<(${[...RAW_TEXT_TAGS, ...RCDATA_TAGS].join("|")})(\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`,
  "giu",
);
const COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;
const BANG_PATTERN = /<![^>]*>/gu;
const TAG_PATTERN = /<(\/?)([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gu;

interface TagToken {
  readonly closing: boolean;
  readonly tag: string;
}

const diagnosticOf = (code: DiagnosticCode, message: string): Diagnostic => ({
  code,
  severity: DIAGNOSTIC_SEVERITY[code],
  message,
});

/** raw text 元素的内容里可能出现 `<` / `</`，先整体剥掉（含其结束标签），避免误判标签。 */
const stripRawText = (html: string): string => html.replaceAll(RAW_TEXT_PATTERN, "<$1$2></$1>");

const tagTokens = (html: string): readonly TagToken[] => {
  const cleaned = stripRawText(html).replaceAll(COMMENT_PATTERN, "").replaceAll(BANG_PATTERN, "");
  const tokens: TagToken[] = [];
  for (const match of cleaned.matchAll(TAG_PATTERN)) {
    const closing = match[1] === "/";
    // 捕获组 2 是正则的必匹配项，String() 只过类型层（noUncheckedIndexedAccess），不是运行时兼底。
    const tag = String(match[2]).toLowerCase();
    if (tag.length > 0) {
      tokens.push({ closing, tag });
    }
  }
  return tokens;
};

const popImplied = (stack: string[], tag: string): void => {
  let top = stack.at(-1);
  while (top !== undefined && CLOSED_BY[top]?.has(tag) === true) {
    stack.pop();
    top = stack.at(-1);
  }
};

const closeTag = (stack: string[], tag: string, diagnostics: Diagnostic[]): void => {
  const index = stack.lastIndexOf(tag);
  if (index === -1) {
    if (!VOID_TAGS.has(tag)) {
      diagnostics.push(diagnosticOf("misnested_tag", `<${tag}> 的结束标签没有对应的开始标签`));
    }
    return;
  }
  for (let position = index + 1; position < stack.length; position += 1) {
    const open = String(stack[position]);
    const parent = String(stack[position - 1]);
    if (FORMATTING_TAGS.has(open)) {
      diagnostics.push(
        diagnosticOf("misnested_tag", `<${open}> 被 </${tag}> 强行闭合，属于错嵌套`),
      );
      continue;
    }
    const legalParents = LEGAL_PARENTS[open];
    if (legalParents !== undefined && !legalParents.has(parent)) {
      const expected = [...legalParents].map((candidate) => `<${candidate}>`).join("/");
      diagnostics.push(
        diagnosticOf(
          "misnested_tag",
          `<${open}> 的父元素是 <${parent}>，应为 ${expected}；被 </${tag}> 强行闭合`,
        ),
      );
    }
  }
  stack.length = index;
};

const openTag = (stack: string[], tag: string): void => {
  popImplied(stack, tag);
  if (!VOID_TAGS.has(tag)) {
    stack.push(tag);
  }
};

export const tagBalanceDiagnostics = (html: string): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const stack: string[] = [];
  for (const token of tagTokens(html)) {
    if (token.closing) {
      closeTag(stack, token.tag, diagnostics);
    } else {
      openTag(stack, token.tag);
    }
  }
  for (const tag of stack) {
    if (!OPTIONAL_END_TAGS.has(tag)) {
      diagnostics.push(diagnosticOf("unclosed_tag", `<${tag}> 到文档结束仍未闭合`));
    }
  }
  return diagnostics;
};
