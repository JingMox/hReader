// 这层管：片段 token 扫描的四条判定各自的"放行/拒绝"两侧 —— `scanTokens`（tokenizer 计数）、
// `assertNoAncestorClosed`（包装祖先被关闭）、`assertTokensSurvived`（解析器丢标签）、
// `assertNothingEscaped`（foster parenting 把内容挪出包装器）；不建树、不碰 IO。
//
// 四条判定都是"解析器不会报错、但写出去的字节里东西没了"的那类缺陷的唯一拦网：
// 每条用例的红=对应判定被删掉/退化成 no-op。

import type { HtmlElementNode, HtmlNode } from "../src/html/constants";
import { parseHtml } from "../src/html/parse";
import type { FragmentTokens } from "../src/ops/patch-node/fragment-tokens";
import {
  assertNoAncestorClosed,
  assertNothingEscaped,
  assertTokensSurvived,
  scanTokens,
} from "../src/ops/patch-node/fragment-tokens";
import { describe, expect, it } from "vitest";

/** 抛出的错误里取 code/message：判定退化成 no-op 时这里拿不到错误，`code` 会变成 `no_throw`。 */
const failureOf = (body: () => void): { code: string; message: string } => {
  try {
    body();
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

/** 从已解析的树里取"到第一个 `<tag>` 的祖先链（含自身）"：链上的对象必须与树同一份。 */
const chainToTag = (root: HtmlNode, tag: string): readonly HtmlElementNode[] => {
  const path: HtmlElementNode[] = [];
  const walk = (node: HtmlNode): boolean => {
    if (node.kind !== "element" && node.kind !== "document") return false;
    if (node.kind === "element") path.push(node);
    if (node.kind === "element" && node.tag === tag) return true;
    for (const child of node.children) {
      if (walk(child)) return true;
    }
    if (node.kind === "element") path.pop();
    return false;
  };
  if (!walk(root)) throw new Error(`测试装置：树里没有 <${tag}>`);
  return path;
};

/** 跑一遍 `assertNoAncestorClosed`：既是"放行/拒绝"的结果，也把 tokens 递回给想看计数器的人。 */
const closedFailureOf = (
  fragment: string,
  ancestors: readonly string[],
): { readonly code: string; readonly message: string; readonly tokens: FragmentTokens } => ({
  ...failureOf(() => {
    assertNoAncestorClosed(scanTokens(fragment, ancestors), ancestors);
  }),
  tokens: scanTokens(fragment, ancestors),
});

/** 跑一遍 `assertTokensSurvived`：`parsed` 是片段已经套上祖先链解析后的文档字串。 */
const survivedFailureOf = (
  fragment: string,
  context: { readonly ancestors: readonly string[]; readonly parsed: string },
): { readonly code: string; readonly message: string } =>
  failureOf(() => {
    assertTokensSurvived(
      scanTokens(fragment, context.ancestors),
      parseHtml(context.parsed).root,
      context.ancestors,
    );
  });

describe("scanTokens · tokenizer 计数", () => {
  it("should count start tags in document order and report no closed ancestor", () => {
    expect(scanTokens("<tr><td>b</td></tr>", ["table", "tbody"])).toEqual({
      startTags: ["tr", "td"],
      closedAncestor: undefined,
    });
  });

  it("should not count wrapper ancestors as fragment start tags", () => {
    // 祖先链是测试自己拼进解析输入里的，不是用户写的：数进来会被 `assertTokensSurvived` 当成多出来的元素。
    expect(scanTokens("<td>b</td>", ["table", "tbody", "tr"]).startTags).toEqual(["td"]);
  });

  it("should treat raw-text container bodies as literal text, not as tags", () => {
    // `<textarea>` 里 parse5 不产生子 token：数进来就会把 `<b>` 误判成“被丢弃”。
    expect(scanTokens("<textarea><b>x</b></textarea>", []).startTags).toEqual(["textarea"]);
  });

  it("should ignore comments, doctypes and whitespace", () => {
    expect(scanTokens("<!-- c --><p>x</p>", []).startTags).toEqual(["p"]);
  });
});

describe("assertNoAncestorClosed · 包装祖先被关闭", () => {
  it("should stay silent when the fragment never closes an ancestor", () => {
    expect(closedFailureOf("<tr><td>b</td></tr>", ["table", "tbody"]).code).toBe("no_throw");
  });

  it("should reject a fragment that closes the wrapper table and name the inner ancestors too", () => {
    const failure = closedFailureOf("<tr><td>b</td></tr></table><p>evil</p>", ["table", "tbody"]);

    expect(failure.code).toBe("invalid_input");
    // 关掉 `<table>` 会连带关掉 `<tbody>`：报文只点 `<table>` 的话用户改完还会再踩一次。
    expect(failure.message).toContain("闭合了外层的 <table>");
    expect(failure.message).toContain("<table><tbody>");
    expect(failure.message).toContain("</table>");
  });

  it("should allow a nested end tag of the same name that closes its own element", () => {
    // `<tbody>` 目标下写一个完整的 `<table>…</table>`：深度先 +1 再 -1，不算逃逸。
    const { tokens } = closedFailureOf("<tbody><tr><td>b</td></tr></tbody>", ["table"]);
    expect(tokens.closedAncestor).toBeUndefined();
  });

  it("should not talk about inner ancestors when the wrapper is a single element", () => {
    // 祖先链只有一层时没有“连带”可讲：硬塞一句会让人以为还关了一层。
    const failure = closedFailureOf("</table><p>x</p>", ["table"]);

    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toContain("闭合了外层的 <table>");
    expect(failure.message).not.toContain("连带包装祖先");
  });
});

describe("assertTokensSurvived · 解析器丢标签", () => {
  it("should stay silent for a table row fragment whose elements all survive", () => {
    const survived = survivedFailureOf("<tr><td>b</td></tr>", {
      ancestors: ["table", "tbody"],
      parsed: "<table><tbody><tr><td>b</td></tr></tbody></table>",
    });

    expect(survived.code).toBe("no_throw");
  });

  it("should not report elements the parser implies (tbody/colgroup/head/body)", () => {
    // 片段里没有 `<tbody>` token，解析器补了一个：补出来的不算“丢失”。
    const survived = survivedFailureOf("<tr><td>b</td></tr>", {
      ancestors: ["table"],
      parsed: "<table><tr><td>b</td></tr></table>",
    });

    expect(survived.code).toBe("no_throw");
  });

  it("should reject a div swallowed by a select and name it", () => {
    const failure = survivedFailureOf("<div>x</div>", {
      ancestors: [],
      parsed: "<select><div>x</div></select>",
    });

    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toContain("1 个元素在解析时被丢弃");
    expect(failure.message).toContain("<div>");
  });

  it("should count a fragment element whose wrapper ancestor is missing from the tree", () => {
    // 祖先标签不在树上时，计数不能变成 NaN：要照实算成“一个都没有”。
    const survived = survivedFailureOf("<p>x</p>", { ancestors: ["table"], parsed: "<p>x</p>" });

    expect(survived.code).toBe("no_throw");
  });
});

describe("assertNothingEscaped · 内容被挪出包装器", () => {
  it("should stay silent when every fragment node sits inside the context", () => {
    const html = "<table><tbody><tr><td>b</td></tr></tbody></table>";
    const root = parseHtml(html).root;

    expect(() => {
      assertNothingEscaped(root, chainToTag(root, "tbody"));
    }).not.toThrow();
  });

  it("should reject a paragraph fostered out of the table body", () => {
    // `<tbody>` 里的 `<p>` 会被 foster-parent 到 `<table>` 之前：根列表只看容器子节点，它就静默丢了。
    const html = "<table><tbody><tr><td>b</td></tr><p>evil</p></tbody></table>";
    const root = parseHtml(html).root;
    const failure = failureOf(() => {
      assertNothingEscaped(root, chainToTag(root, "tbody"));
    });

    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toContain("移到了包装容器之外");
    expect(failure.message).toContain("<p>");
  });
});

describe("assertNothingEscaped · 没有包哨器可谈的时候", () => {
  it("should do nothing when there is no context chain to compare against", () => {
    // 没有上下文层（片段直接挂在文档里）时没有“包装器”可谈。
    const root = parseHtml("<div><p>x</p></div>").root;
    expect(() => {
      assertNothingEscaped(root, []);
    }).not.toThrow();
  });

  it("should treat a context that is not in the tree as wrapping nothing", () => {
    // 调用方传进来的链元素来自别的树（自己拼的）：`pathToNode` 在这棵树上找不到它，
    // 不能因此崩；当成“什么都没被包装”照常报逸逸，否则用户只看到一个 TypeError。
    const root = parseHtml("<div><p>x</p></div>").root;
    const detached = chainToTag(parseHtml("<div><p>y</p></div>").root, "div");
    const failure = failureOf(() => {
      assertNothingEscaped(root, detached);
    });

    expect(failure.code).toBe("invalid_input");
    expect(failure.message).toContain("移到了包装容器之外");
  });
});
