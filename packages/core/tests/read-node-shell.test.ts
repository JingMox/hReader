// 这层管：`hr_read_node` 的外壳边界（禁读目标 + 外壳剔除 + 泄漏面）；不测选择器文法与截断。

import { describe, expect, it } from "vitest";

import { HrError, parseHtml, readNode } from "../src/index";

const META = (targetId: string): string =>
  `<script id="hr-meta">{"annotations":[{"id":"an-${targetId}","targetId":"${targetId}","comment":"备注 ${targetId}"}]}</script>`;

const ARTICLE =
  '<article data-hr-id="post">' +
  META("head") +
  '<style id="hr-theme">.a{color:red}</style>' +
  '<h2 data-hr-id="head">标题</h2>' +
  `<section data-hr-id="s1">${META("s1")}<p>正文</p></section>` +
  "</article>";

const read = (html: string, target: string): ReturnType<typeof readNode> =>
  readNode(parseHtml(html), target);

const codeOf = (html: string, target: string): string => {
  try {
    read(html, target);
  } catch (error) {
    return error instanceof HrError ? error.code : "no-throw";
  }
  return "no-throw";
};

const FORBIDDEN_TARGETS = ["html", "body", "head", "script", "style"];

describe("shell · targets that must never be readable", () => {
  it.each(FORBIDDEN_TARGETS)("should refuse %s with node_not_allowed", (target) => {
    expect(codeOf(ARTICLE, target)).toBe("node_not_allowed");
  });

  it("should refuse a template target even when it is the only element", () => {
    const html = '<article data-hr-id="post"><template><p>t</p></template></article>';

    expect(codeOf(html, "template")).toBe("node_not_allowed");
  });

  it("should refuse the reserved anchor ids by name (never node_not_found)", () => {
    // 锚点的 id 空间被整体保留：`#hr-meta` 连"找不到"都不许说，直接判禁读。
    expect(codeOf(ARTICLE, "#hr-meta")).toBe("node_not_allowed");
    expect(codeOf(ARTICLE, "#hr-theme")).toBe("node_not_allowed");
    expect(codeOf(ARTICLE, '[data-hr-id="hr-meta"]')).toBe("node_not_allowed");
  });
});

const ARTICLE_READ = read(ARTICLE, "article");
const ARTICLE_CODES = ARTICLE_READ.diagnostics.map((diagnostic) => diagnostic.code);

describe("shell · stripping anchors out of an article read", () => {
  it("should remove every anchor script and the theme style", () => {
    for (const anchor of ["<script", "<style", "hr-meta", "hr-theme"]) {
      expect(ARTICLE_READ.html).not.toContain(anchor);
    }
  });

  it("should not leak any meta JSON or annotation payload", () => {
    expect(ARTICLE_READ.html).not.toContain("annotations");
    expect(ARTICLE_READ.html).not.toContain("an-head");
    expect(ARTICLE_READ.html).not.toContain("备注 head");
  });

  it("should keep the real content and the root anchor", () => {
    expect(ARTICLE_READ.html).toContain('<article data-hr-id="post">');
    expect(ARTICLE_READ.html).toContain('<h2 data-hr-id="head">标题</h2>');
    expect(ARTICLE_READ.html).toContain("<p>正文</p>");
  });

  it("should report stripped_shell with the real count in one diagnostic", () => {
    expect(ARTICLE_CODES).toEqual(["stripped_shell"]);
    expect(ARTICLE_READ.diagnostics[0]?.message).toBe(
      "已剔除 3 处不可读内容（页面外壳 / 可执行容器）",
    );
    expect(ARTICLE_READ.diagnostics[0]?.severity).toBe("warning");
  });

  it("should strip a nested anchor deep inside a subtree too", () => {
    const deep = read(
      `<article data-hr-id="post"><div data-hr-id="outer"><div>${META("x")}</div></div></article>`,
      "#outer",
    );

    expect(deep.html).not.toContain("hr-meta");
    expect(deep.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["stripped_shell"]);
    expect(deep.diagnostics[0]?.message).toBe("已剔除 1 处不可读内容（页面外壳 / 可执行容器）");
  });
});

describe("shell · content-level stripping", () => {
  it("should strip an ordinary inline script instead of shipping it out", () => {
    const result = read(
      '<article data-hr-id="post"><script>run()</script><p>x</p></article>',
      "article",
    );

    expect(result.html).not.toContain("run()");
    expect(result.html).toContain("<p>x</p>");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["stripped_shell"]);
  });

  it("should strip template content even though the target is an article", () => {
    const result = read(
      '<article data-hr-id="post"><template><p>模板内</p></template><p>可见</p></article>',
      "article",
    );

    expect(result.html).not.toContain("模板内");
    expect(result.html).toContain("可见");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["stripped_shell"]);
  });

  it("should keep an inline style out of the output as well", () => {
    const result = read(
      '<article data-hr-id="post"><style>.b{color:blue}</style><p>y</p></article>',
      "article",
    );

    expect(result.html).not.toContain("color:blue");
    expect(result.html).toContain("<p>y</p>");
  });
});

describe("shell · inert surfaces stay readable", () => {
  it("should keep a comment containing </body> inert and re-parseable", () => {
    const result = read('<article data-hr-id="post"><!-- </body> --><p>x</p></article>', "article");

    expect(result.html.startsWith("<article")).toBe(true);
    expect(result.html.endsWith("</article>")).toBe(true);
    expect(parseHtml(result.html).diagnostics).toEqual([]);
  });

  it("should keep noscript content readable and re-parseable", () => {
    const result = read(
      '<article data-hr-id="post"><noscript><p>回退</p></noscript></article>',
      "article",
    );

    expect(result.html).toContain("回退");
    expect(parseHtml(result.html).diagnostics).toEqual([]);
  });

  it("should survive a script whose text contains a closing script tag", () => {
    const html =
      '<article data-hr-id="post"><script>var s = "</script>";</script><p>x</p></article>';

    expect(read(html, "article").html).toContain("<p>x</p>");
  });
});
