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
  { fragment: "<div>", code: "invalid_fragment", marker: "结构不完整" },
  { fragment: "<b><i>x</b></i>", code: "invalid_fragment", marker: "结构不完整" },
];

/** 外壳可省、结构完整：这些必须放行，否则"拒绝"就没有对照组。 */
export const ACCEPTED_FRAGMENTS: readonly { readonly fragment: string; readonly tag: string }[] = [
  { fragment: "<p>普通</p>", tag: "p" },
  { fragment: "<html><body><p>外壳</p></body></html>", tag: "p" },
  { fragment: "<div><!-- 注释 --><p>带注释</p></div>", tag: "div" },
  { fragment: "<ul><li>a<li>b</ul>", tag: "ul" },
];
