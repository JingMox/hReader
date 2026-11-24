// 这层管：v3#16/#17 的 SVG 动画绕过面（审计员抓到的真实漏洞）——按 `;` 逐项判、
// 且动画的"元素级 URL 属性"目标必须与直接写 href 同口径；纯层 import，不经 io。

import { describe, expect, it } from "vitest";

import { parseFragment } from "../../src/ops/patch-node";

const codeOfFragment = (html: string): string => {
  try {
    parseFragment(html);
    return "no_throw";
  } catch (error: unknown) {
    const code: unknown = Reflect.get(Object(error), "code");
    return typeof code === "string" ? code : "no_code";
  }
};

describe("v3#17 · values 是分号列表，必须逐项判（回归：审计漏洞）", () => {
  it.each([
    '<svg><animate attributeName="href" values="safe;javascript:alert(1)"/></svg>',
    '<svg><animate attributeName="href" values="0 ; 1 ; JavaScript:alert(1)"/></svg>',
    '<svg><animate attributeName="xlink:href" values="a;b;data:text/html;base64,xx"/></svg>',
    '<svg><set attributeName="src" values="ok;java&#9;script:alert(1)"/></svg>',
  ])("should reject %s with forbidden_content", (fragment) => {
    expect(codeOfFragment(fragment)).toBe("forbidden_content");
  });

  it("should not treat a single-value semicolon as a list separator (v3#17)", () => {
    expect(codeOfFragment('<svg><animate attributeName="href" to="safe;../x.html"/></svg>')).toBe(
      "no_throw",
    );
    expect(codeOfFragment('<svg><animate attributeName="href" values="0;1;0"/></svg>')).toBe(
      "no_throw",
    );
    expect(codeOfFragment('<svg><animate attributeName="href" values="red;blue"/></svg>')).toBe(
      "no_throw",
    );
  });
});

describe("v3#16 · 动画目标 URL 属性与直接写 href 同口径", () => {
  it.each([
    '<svg><animate attributeName="href" to="javascript:alert(1)"/></svg>',
    '<svg><animate attributeName="href" from="  JaVaScRiPt:alert(1)"/></svg>',
    '<svg><animate attributeName="href" by="data:text/html,<script>"/></svg>',
    '<svg><a href="safe;javascript:alert(1)">t</a></svg>',
    '<svg><a xlink:href="0;data:text/html">t</a></svg>',
  ])("should reject %s with forbidden_content", (fragment) => {
    expect(codeOfFragment(fragment)).toBe("forbidden_content");
  });

  it("should still allow animations that target ordinary presentation attributes", () => {
    expect(codeOfFragment('<svg><animate attributeName="fill" to="red"/></svg>')).toBe("no_throw");
    // 没有 attributeName 的动画（target 为空）不该被 URL 判定误杀。
    expect(codeOfFragment('<svg><animate to="safe"/></svg>')).toBe("no_throw");
    expect(codeOfFragment('<svg><animate attributeName="opacity" values="0;1;0"/></svg>')).toBe(
      "no_throw",
    );
    // 属性级拒绝是全局的；svg 之外的 <animate> 不再叠加"动画目标"判定。
    expect(codeOfFragment('<div><animate attributeName="href" to="safe"/></div>')).toBe("no_throw");
    expect(codeOfFragment('<div><animate attributeName="href" to="javascript:x"/></div>')).toBe(
      "forbidden_content",
    );
  });
});

describe("meta · 只带 charset 也要拒", () => {
  it("should reject <meta charset> and <meta http-equiv> separately", () => {
    expect(codeOfFragment('<meta charset="utf-8"/>')).toBe("forbidden_content");
    expect(codeOfFragment('<meta http-equiv="refresh" content="0;url=/x"/>')).toBe(
      "forbidden_content",
    );
    expect(codeOfFragment('<meta name="viewport" content="width=device-width"/>')).toBe("no_throw");
  });
});

describe("G3.4 · 输入类矩阵（元素 × 属性 × 单值/列表）现成缺的那几条", () => {
  // 语料表里原先只有 href 一个属性名；src/by/xlink:href 与 from/by 这两条轴一直是空的。
  it.each([
    ['<svg><animate attributeName="src" from="javascript:alert(1)"/></svg>', "src + from 单值"],
    ['<svg><animate attributeName="src" by="data:text/html,<b>"/></svg>', "src + by 单值"],
    [
      '<svg><animate attributeName="src" values="ok;javascript:alert(1)"/></svg>',
      "src + values 列表",
    ],
    [
      '<svg><set attributeName="xlink:href" values="a;b;data:text/html"/></svg>',
      "xlink:href + set 列表",
    ],
    ['<svg><animate xlink:href="safe;javascript:alert(1)"/></svg>', "通用扫描 xlink:href 列表"],
  ])("should reject %s (%s) with forbidden_content", (fragment) => {
    expect(codeOfFragment(fragment)).toBe("forbidden_content");
  });

  it.each([
    ['<svg><animate attributeName="src" values="a.png;b.png"/></svg>', "src 列表全是相对 URL"],
    [
      '<svg><animate attributeName="xlink:href" to="https://ok.example/a;b"/></svg>',
      "单值里的分号",
    ],
    ['<svg><animate attributeName="stroke-width" values="1;2;1"/></svg>', "非 URL 数值列表"],
  ])("should allow %s (%s)", (fragment) => {
    expect(codeOfFragment(fragment)).toBe("no_throw");
  });
});
