// 这层管：`hasExecutableContent`——元素级（script/iframe/SMIL）与属性级（on*/伪协议/srcdoc/meta refresh）探测。

import { describe, expect, it } from "vitest";

import { hasExecutableContent, parseHtml } from "@hreader/core";

const hasExec = (html: string): boolean => hasExecutableContent(parseHtml(html).root);

describe("hasExecutableContent · 元素级", () => {
  it.each(["script", "iframe", "object", "embed", "applet", "set", "foreignObject"])(
    "should report executable when the doc contains <%s>",
    (tag) => {
      expect(hasExec(`<div><${tag}>x</${tag}></div>`)).toBe(true);
    },
  );

  it("should report executable for a script in head, not only in body", () => {
    expect(hasExec("<html><head><script>go()</script></head><body><p>x</p></body></html>")).toBe(
      true,
    );
  });
});

describe("hasExecutableContent · 属性级", () => {
  it("should report executable for on* event attributes", () => {
    expect(hasExec('<p onclick="go()">x</p>')).toBe(true);
    expect(hasExec('<svg onload="go()"></svg>')).toBe(true);
  });

  it.each([
    '<a href="javascript:go()">x</a>',
    '<a href="java\tscript:go()">x</a>',
    '<img src="data:text/html;base64,AAAA">',
    '<svg><a xlink:href="vbscript:go()">x</a></svg>',
  ])("should report executable for dangerous URL %s", (html) => {
    expect(hasExec(html)).toBe(true);
  });

  it("should report executable for an iframe srcdoc payload", () => {
    expect(hasExec('<div srcdoc="<script>go()</script>">x</div>')).toBe(true);
  });

  it("should report executable for a meta refresh to a script URL", () => {
    expect(hasExec('<meta http-equiv="refresh" content="0; url=javascript:go()"><p>x</p>')).toBe(
      true,
    );
  });
});

describe("hasExecutableContent · 干净文档", () => {
  it("should report non-executable for plain content and safe links", () => {
    expect(
      hasExec(
        '<article data-hr-id="a"><p data-hr-id="b">x</p><a href="https://e.t">y</a></article>',
      ),
    ).toBe(false);
  });

  it("should report non-executable for style/link/base containers (not script-capable)", () => {
    expect(hasExec("<head><style>p{color:red}</style><link href='x'><base href='/'>")).toBe(false);
  });

  it("should report non-executable for a benign meta refresh", () => {
    expect(hasExec('<meta http-equiv="refresh" content="0; url=https://e.t/"><p>x</p>')).toBe(
      false,
    );
  });

  it("should report non-executable for a meta content attribute without refresh", () => {
    expect(hasExec('<meta name="x" content="javascript:go()"><p>x</p>')).toBe(false);
  });

  it("should report non-executable for a meta without http-equiv", () => {
    expect(hasExec('<meta charset="utf-8"><p>x</p>')).toBe(false);
  });
});
