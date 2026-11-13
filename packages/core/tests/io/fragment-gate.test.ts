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
