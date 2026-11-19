// 这层管：纯层片段校验的对抗矩阵（只 import ops/patchNode，不经过 io）与"宽容边界"记录。

import { describe, expect, it } from "vitest";

import type { HtmlElementNode } from "../../src/html/constants";

import { parseFragment } from "../../src/ops/patchNode";
import { ACCEPTED_FRAGMENTS, REJECTED_FRAGMENTS, rejectedFragmentOf } from "./fragments";

describe("parseFragment · 必须拒绝的片段", () => {
  it.each(REJECTED_FRAGMENTS)(
    "should reject $fragment with $code",
    ({ fragment, code, marker }) => {
      const failure = rejectedFragmentOf(fragment);
      expect(failure.code).toBe(code);
      expect(failure.message).toContain(marker);
    },
  );
});

const fragmentElementOf = (html: string): HtmlElementNode => {
  const node = parseFragment(html);
  if (node.kind !== "element") throw new Error(`片段根不是元素：${node.kind}`);
  return node;
};

describe("parseFragment · 必须放行的片段", () => {
  it.each(ACCEPTED_FRAGMENTS)("should accept $fragment", ({ fragment, tag }) => {
    expect(fragmentElementOf(fragment).tag).toBe(tag);
  });

  it("should keep the author attributes verbatim (id stripping happens later)", () => {
    const node = fragmentElementOf('<p data-hr-id="p1" class="lead" title="t">x</p>');

    expect(node.attrs).toEqual([
      ["class", "lead"],
      ["title", "t"],
    ]);
  });

  it("should keep nested inline markup and text", () => {
    expect(fragmentElementOf("<p>前<b>中</b>后</p>").children.length).toBe(3);
  });

  it("should tolerate whitespace around a single root and a missing end tag", () => {
    expect(fragmentElementOf("  <p>x</p>  ").tag).toBe("p");
    expect(fragmentElementOf("<p>未闭合").tag).toBe("p");
  });

  it("should drop the shell but keep the inner element as the only root", () => {
    expect(fragmentElementOf("<html><body><section>x</section></body></html>").tag).toBe("section");
  });
});

describe("parseFragment · SVG 动画改写事件属性", () => {
  const rejects = (html: string): string => {
    try {
      parseFragment(html);
      return "no_throw";
    } catch (error: unknown) {
      const code: unknown = Reflect.get(Object(error), "code");
      return typeof code === "string" ? code : "no_code";
    }
  };

  it("should reject an SVG animation that writes an on* attribute", () => {
    expect(rejects('<svg><set attributeName="onload" to="alert(1)"/></svg>')).toBe(
      "forbidden_content",
    );
    expect(rejects('<svg><animate attributeName="onclick" to="x"/></svg>')).toBe(
      "forbidden_content",
    );
  });

  it("should allow an SVG animation targeting a non-event attribute and a non-svg <set>", () => {
    expect(fragmentElementOf('<svg><set attributeName="fill" to="red"/></svg>').tag).toBe("svg");
    expect(fragmentElementOf('<div><set attributeName="onload"/></div>').tag).toBe("div");
  });
});

describe("parseFragment · 解析器会吞掉/挪走的构造", () => {
  // 这四类片段的共同点：解析器**不报错**，只是把元素忽略掉或挪到容器之外。
  // 拦截它们的分别是 F11 的四条判定 —— 任何一条退化成 no-op，这里就会从 `invalid_*` 变回 `no_throw`。
  const CASES: readonly { fragment: string; code: string; marker: string; why: string }[] = [
    {
      fragment: "<select><div>x</div></select>",
      code: "invalid_input",
      marker: "被丢弃（<div>）",
      why: "`<select>` 里 `<div>` 被整类忽略（assertTokensSurvived）",
    },
    {
      fragment: "<td><tr>x</tr></td>",
      code: "invalid_input",
      marker: "移到了包装容器之外（<tr>/文本）",
      why: "`<tr>` 不能嵌在 `<td>` 里，被挤到包装器之外（assertNothingEscaped）",
    },
    {
      fragment: "<table><p>x</p></table>",
      code: "invalid_fragment",
      marker: "恰好有一个根元素（实际 2 个根级内容节点）",
      why: "`<p>` 被 foster-parent 到 `<table>` 之前，根列表多出一个（assertNothingEscaped 之前的根数校验）",
    },
    {
      fragment: "<tr><td>b</td></tr></table><p>evil</p>",
      code: "invalid_input",
      marker: "闭合了外层的 <table>",
      why: "`</table>` 关掉包装祖先，后面的 `<p>` 被挤到包装器之外（assertNoAncestorClosed，解析前就拒）",
    },
  ];

  it.each(CASES)("should reject $fragment ($why)", ({ fragment, code, marker }) => {
    const failure = rejectedFragmentOf(fragment);

    expect(failure.code).toBe(code);
    expect(failure.message).toContain(marker);
  });
});
