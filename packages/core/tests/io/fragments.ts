// 这层管：片段校验的对抗语料与"取错误码 + 报文"的唯一入口；不含断言。

import { parseFragment } from "../../src/ops/patchNode";

export interface RejectedFragment {
  readonly fragment: string;
  readonly code: string;
  /** 报文里必须出现的字符串：错误码对了但点错了名字，同样是失败。 */
  readonly marker: string;
}

export interface FragmentFailure {
  readonly code: string;
  readonly message: string;
}

export const rejectedFragmentOf = (fragment: string): FragmentFailure => {
  try {
    parseFragment(fragment);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    const message: unknown = Reflect.get(Object(error), "message");
    return {
      code: typeof code === "string" ? code : "no_code",
      message: typeof message === "string" ? message : "no_message",
    };
  }
  return { code: "no_throw", message: "" };
};

export const REJECTED_FRAGMENTS: RejectedFragment[] = [
  { fragment: "<ScRiPt>alert(1)</ScRiPt>", code: "forbidden_content", marker: "<script>" },
  { fragment: '<svg onload="alert(1)"></svg>', code: "forbidden_content", marker: "onload" },
  { fragment: '<p onfocus="x()">y</p>', code: "forbidden_content", marker: "onfocus" },
  {
    fragment: '<a href="&#106;avascript:alert(1)">x</a>',
    code: "forbidden_content",
    marker: "javascript:",
  },
  {
    fragment: '<meta http-equiv="refresh" content="0;url=x">',
    code: "forbidden_content",
    marker: "meta http-equiv",
  },
  { fragment: "<p>a</p><p>b</p>", code: "invalid_fragment", marker: "恰好有一个根元素" },
  { fragment: "纯文本", code: "invalid_fragment", marker: "恰好有一个根元素" },
  {
    fragment: "<p>a</style><style>body{}</style></p>",
    code: "forbidden_content",
    marker: "<style>",
  },
  {
    fragment: '<a href="JaVa\tScRiPt:alert(1)">x</a>',
    code: "forbidden_content",
    marker: "javascript:",
  },
  {
    fragment: '<img src="data:text/html;base64,eA==">',
    code: "forbidden_content",
    marker: "data:",
  },
  { fragment: '<P ONCLICK="x">y</P>', code: "forbidden_content", marker: "onclick" },
  { fragment: "<!-- 只有注释 -->", code: "invalid_fragment", marker: "恰好有一个根元素" },
  { fragment: "", code: "invalid_fragment", marker: "根元素" },
  { fragment: "   \n\t ", code: "invalid_fragment", marker: "根元素" },
  { fragment: "<!-- only a comment -->", code: "invalid_fragment", marker: "根元素" },
  // 单根但未闭合/交错嵌套的片段**不再列为非法**：`fragment.ts` 已改成"先解析后校验"，
  // 可选结束标签由 HTML5 容错解析自动闭合（见 ACCEPTED_FRAGMENTS 的两条对照）。
  // 裸 `<tr>` / `<td>` 片段同理：`CONTEXT_ANCESTORS` 会让它们套上 `<table><tbody>` 祖先链解析，
  // 解析回来仍是那个元素，所以它们属于 ACCEPTED_FRAGMENTS（见下方两条）。
];

/** 外壳可省、结构完整：这些必须放行，否则"拒绝"就没有对照组。 */
export const ACCEPTED_FRAGMENTS: readonly { readonly fragment: string; readonly tag: string }[] = [
  { fragment: "<p>普通</p>", tag: "p" },
  { fragment: "<html><body><p>外壳</p></body></html>", tag: "p" },
  { fragment: "<div><!-- 注释 --><p>带注释</p></div>", tag: "div" },
  { fragment: "<ul><li>a<li>b</ul>", tag: "ul" },
  // 反面对照：表格要把整张表当片段给，才拿得到表格上下文。
  { fragment: "<table><tr><td>x</td></tr></table>", tag: "table" },
  // 表格结构片段：单独解析会丢标签，套祖先链解析后标签还在，所以放行（落盘位置见 fragment-gate-io）。
  { fragment: "<tr><td>b</td></tr>", tag: "tr" },
  { fragment: "<td>b</td>", tag: "td" },
  // 未闭合与交错嵌套：HTML5 容错解析后仍是单根元素，照收（拒绝它们等于重造解析器规则）。
  { fragment: "<div>", tag: "div" },
  { fragment: "<b><i>x</b></i>", tag: "b" },
];
