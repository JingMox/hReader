// sanitize 双预设测试：print 逐字节冻结的裁切口径、import 面向外来文档的更严口径。
// 树构造用合成节点（判定不依赖解析器）与 parseHtml（依赖实体解码的场景）两条路。

import { describe, expect, it } from "vitest";

import {
  attributeOf,
  hasExternalResource,
  isCountedImage,
  isDroppedNode,
  parseHtml,
  sanitizedAttributesOf,
  serializeHtml,
} from "../src/index";
import type { HtmlAttribute, HtmlElementNode, HtmlNode } from "../src/html/constants";
import { attributeValue, findElement } from "./html-support";

const element = (tag: string, attrs: readonly HtmlAttribute[] = []): HtmlElementNode => ({
  kind: "element",
  tag,
  attrs,
  children: [],
});

const attrNamesOf = (node: HtmlElementNode, preset: "print" | "import"): readonly string[] =>
  sanitizedAttributesOf(node, preset).map(([name]) => name);

describe("print 预设 · 整删判定", () => {
  it.each([
    "script",
    "style",
    "link",
    "base",
    "meta",
    "iframe",
    "object",
    "embed",
    "video",
    "audio",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    // parse5 在 SVG 语境产驼峰名，判定必须归一化
    "image",
    "use",
    "feImage",
  ])("should drop <%s> element when preset is print", (tag) => {
    expect(isDroppedNode(element(tag), "print")).toBe(true);
  });

  it("should drop element carrying UI markers when preset is print", () => {
    expect(isDroppedNode(element("div", [["data-hr-ui", "toolbar"]]), "print")).toBe(true);
    expect(isDroppedNode(element("p", [["contenteditable", "true"]]), "print")).toBe(true);
    expect(isDroppedNode(element("div", [["class", "x hr-sidebar y"]]), "print")).toBe(true);
    // class 串里夹带空白 token 不应妨碍命中
    expect(isDroppedNode(element("div", [["class", "  hr-toc-toggle  "]]), "print")).toBe(true);
    expect(isDroppedNode(element("div", [["class", "hr-mode-toggle"]]), "print")).toBe(true);
  });

  it("should keep ordinary content elements when preset is print", () => {
    expect(isDroppedNode(element("p", [["class", "intro"]]), "print")).toBe(false);
    expect(isDroppedNode(element("svg", [["class", "hr-ish"]]), "print")).toBe(false);
    // SMIL/隐藏壳是 import 才砍的面，print 的既有契约不含它们
    expect(isDroppedNode(element("animate"), "print")).toBe(false);
    expect(isDroppedNode(element("template"), "print")).toBe(false);
    expect(isDroppedNode(element("xmp"), "print")).toBe(false);
  });
});

describe("print 预设 · 属性剥除", () => {
  it("should strip on* attributes and keep the rest when preset is print", () => {
    const p = element("p", [
      ["id", "a"],
      ["onclick", "steal()"],
      ["onload", "x()"],
      ["class", "c"],
    ]);
    expect(sanitizedAttributesOf(p, "print")).toEqual([
      ["id", "a"],
      ["class", "c"],
    ]);
  });

  it.each([
    ["href", "javascript:alert(1)"],
    ["href", "vbscript:msgbox(1)"],
    ["href", "data:text/html;base64,PHNjcmlwdD4="],
    ["href", "JAVASCRIPT:alert(1)"],
    ["href", "java\tscript:alert(1)"],
    ["href", "  javascript:alert(1)"],
    ["src", "javascript:alert(1)"],
    ["xlink:href", "javascript:alert(1)"],
  ])("should strip %s=%s when preset is print", (name, value) => {
    expect(attrNamesOf(element("a", [[name, value]]), "print")).toEqual([]);
  });

  it("should keep content links when preset is print", () => {
    const link = element("a", [
      ["href", "https://example.com/x"],
      ["title", "外部链接"],
    ]);
    expect(sanitizedAttributesOf(link, "print")).toEqual([
      ["href", "https://example.com/x"],
      ["title", "外部链接"],
    ]);
    // 只有 data:text/html 算脚本协议；其余 data: 值在 print 契约里原样保留
    expect(attrNamesOf(element("a", [["href", "data:text/plain,hi"]]), "print")).toEqual(["href"]);
  });

  it("should strip style only when it reaches out when preset is print", () => {
    expect(
      attrNamesOf(
        element("p", [["style", "background: url(http://evil.example/bg.png)"]]),
        "print",
      ),
    ).toEqual([]);
    expect(
      attrNamesOf(element("p", [["style", "background: url(//evil.example/bg.png)"]]), "print"),
    ).toEqual([]);
    // 没有外链 url() 的 style 原样保留
    expect(attrNamesOf(element("p", [["style", "color: red"]]), "print")).toEqual(["style"]);
    expect(
      attrNamesOf(
        element("p", [["style", "background: url(data:image/png;base64,AAAA)"]]),
        "print",
      ),
    ).toEqual(["style"]);
  });
});

describe("print 预设 · 外链资源判定", () => {
  it.each([
    ["relative src", element("img", [["src", "x.png"]]), true],
    ["absolute http src", element("img", [["src", "https://cdn.example/x.png"]]), true],
    ["inline data:image src", element("img", [["src", "data:image/png;base64,AAAA"]]), false],
    ["uppercase data:image src", element("img", [["src", " DATA:IMAGE/PNG;base64,AAAA"]]), false],
    ["external poster", element("img", [["poster", "https://cdn.example/p.png"]]), true],
    ["empty srcset", element("img", [["srcset", ""]]), false],
    [
      "all-inline srcset",
      element("img", [["srcset", "data:image/png;base64,A 1x, data:image/png;base64,B 2x"]]),
      false,
    ],
    [
      "mixed srcset with external tail",
      element("img", [["srcset", "data:image/png;base64,A 1x, https://cdn.example/b.png 2x"]]),
      true,
    ],
    [
      "srcset with external head",
      element("img", [["srcset", "https://cdn.example/a.png 1x, data:image/png;base64,B 2x"]]),
      true,
    ],
    // 非 base64 的 data: 载荷按 fail-closed 判外链
    [
      "srcset non-base64 payload",
      element("img", [["srcset", "data:image/svg+xml,<svg/> 1x"]]),
      true,
    ],
    ["no resource attributes", element("img", [["alt", "x"]]), false],
  ])("should return external=%s when preset is print", (_name, node, expected) => {
    expect(hasExternalResource(node, "print")).toBe(expected);
  });
});

describe("import 预设 · 整删判定", () => {
  it.each(["script", "style", "iframe", "object", "embed", "form", "input", "feImage"])(
    "should keep print-level drops for <%s> when preset is import",
    (tag) => {
      expect(isDroppedNode(element(tag), "import")).toBe(true);
    },
  );

  it.each([
    // SMIL 动画：能改写父节点事件/URL 属性，属性级过滤挡不住
    "animate",
    "animateMotion",
    "animateTransform",
    "set",
    "discard",
    "mpath",
    // SVG 内嵌 HTML 的二次入口
    "foreignObject",
    // 隐藏/惰性内容壳
    "template",
    "noscript",
    // 老式嵌入与 raw-text（子树是文本，脚本串会原样穿过过滤）
    "applet",
    "frame",
    "frameset",
    "noembed",
    "noframes",
    "xmp",
    "plaintext",
  ])("should additionally drop <%s> element when preset is import", (tag) => {
    expect(isDroppedNode(element(tag), "import")).toBe(true);
  });

  it("should drop UI-marked elements when preset is import", () => {
    expect(isDroppedNode(element("div", [["data-hr-ui", "toolbar"]]), "import")).toBe(true);
    expect(isDroppedNode(element("div", [["class", "hr-sidebar"]]), "import")).toBe(true);
  });

  it("should keep contenteditable element when preset is import", () => {
    // 外来文档常把 contenteditable 挂在 body/大容器上，整删会把正文带走——只剥属性
    const editable = element("body", [["contenteditable", "true"]]);
    expect(isDroppedNode(editable, "import")).toBe(false);
    expect(attrNamesOf(editable, "import")).toEqual([]);
  });

  it("should keep semantic containers when preset is import", () => {
    expect(isDroppedNode(element("article"), "import")).toBe(false);
    expect(isDroppedNode(element("svg"), "import")).toBe(false);
    expect(isDroppedNode(element("math"), "import")).toBe(false);
    expect(isDroppedNode(element("picture"), "import")).toBe(false);
  });
});

describe("import 预设 · 事件属性与伪协议", () => {
  it("should strip on* attributes case-insensitively when preset is import", () => {
    // 手造树上的大写名：import 不假设输入树一定出自 parse5（parse5 会小写化）
    const svg = element("svg", [
      ["onload", "alert(1)"],
      ["ONCLICK", "alert(2)"],
      ["width", "10"],
    ]);
    expect(attrNamesOf(svg, "import")).toEqual(["width"]);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "  javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    // 严格归一化剥全部空白/控制字符：NEL(C1)、NBSP 都不是绕过面
    "java\u0085script:alert(1)",
    "java\u00A0script:alert(1)",
  ])("should strip href=%s when preset is import", (value) => {
    expect(attrNamesOf(element("a", [["href", value]]), "import")).toEqual([]);
  });

  it("should strip script URLs on src and xlink:href when preset is import", () => {
    expect(attrNamesOf(element("img", [["src", "javascript:x"]]), "import")).toEqual([]);
    expect(attrNamesOf(element("a", [["xlink:href", "javascript:x"]]), "import")).toEqual([]);
  });

  it("should strip entity-decoded javascript: URLs when preset is import", () => {
    // 实体编码在解析阶段就解码：&#106; → j、&Tab; → \t，归一化后与字面 javascript: 同判
    const root = parseHtml(
      '<article><a href="&#106;avascript:alert(1)">a</a><a href="java&Tab;script:alert(2)">b</a></article>',
    ).root;
    const links = findElement(root, "article")?.children.filter(
      (child): child is HtmlElementNode => child.kind === "element",
    );
    for (const link of links ?? []) {
      expect(attrNamesOf(link, "import")).toEqual([]);
      expect(link.children[0]).toMatchObject({ kind: "text" });
    }
  });
});

describe("import 预设 · 链接与资源口径", () => {
  it("should strip every data: URL on links when preset is import", () => {
    // 链接上的 data: 是整个文档的载荷面，连 data:image 也不留
    expect(attrNamesOf(element("a", [["href", "data:text/plain,x"]]), "import")).toEqual([]);
    expect(attrNamesOf(element("a", [["href", "data:image/png;base64,AAAA"]]), "import")).toEqual(
      [],
    );
    expect(
      attrNamesOf(element("a", [["xlink:href", "data:image/png;base64,AAAA"]]), "import"),
    ).toEqual([]);
  });

  it("should keep navigable links when preset is import", () => {
    for (const href of [
      "https://example.com/x",
      "http://example.com/x",
      "mailto:a@example.com",
      "#anchor",
      "./local/page.html",
      "../up.html",
    ]) {
      expect(attrNamesOf(element("a", [["href", href]]), "import")).toEqual(["href"]);
    }
  });

  it("should keep data:image on resource attributes when preset is import", () => {
    // data:image 只在资源属性上放行
    const img = element("img", [["src", "data:image/png;base64,AAAA"]]);
    expect(hasExternalResource(img, "import")).toBe(false);
    expect(attrNamesOf(img, "import")).toEqual(["src"]);
  });

  it("should drop external resources at element level when preset is import", () => {
    expect(
      hasExternalResource(element("img", [["src", "https://cdn.example/x.png"]]), "import"),
    ).toBe(true);
    expect(hasExternalResource(element("img", [["src", "x.png"]]), "import")).toBe(true);
    expect(
      hasExternalResource(
        element("img", [["srcset", "data:image/png;base64,A 1x, https://cdn.example/b.png 2x"]]),
        "import",
      ),
    ).toBe(true);
    expect(
      hasExternalResource(
        element("img", [["srcset", "data:image/png;base64,A 1x, data:image/png;base64,B 2x"]]),
        "import",
      ),
    ).toBe(false);
  });
});

describe("import 预设 · 剥掉的属性面", () => {
  it.each([
    "contenteditable",
    "autofocus",
    "tabindex",
    "accesskey",
    "draggable",
    "spellcheck",
    "hidden",
    "ping",
    "background",
  ])("should strip %s attribute when preset is import", (name) => {
    expect(
      attrNamesOf(
        element("p", [
          [name, "x"],
          ["id", "keep"],
        ]),
        "import",
      ),
    ).toEqual(["id"]);
  });

  it("should strip every inline style when preset is import", () => {
    // 托管文档的长相归主题（inline_style 本来就是警告面），外来 style 还常带定位/隐藏/外链
    expect(attrNamesOf(element("p", [["style", "color: red"]]), "import")).toEqual([]);
    expect(attrNamesOf(element("p", [["style", "display: none"]]), "import")).toEqual([]);
  });

  it("should strip the data-hr-* namespace when preset is import", () => {
    const node = element("section", [
      ["data-hr-id", "foreign-id"],
      ["data-hr-component", "kpi-bento"],
      ["data-hr-custom", "x"],
      ["data-note", "keep"],
    ]);
    expect(attrNamesOf(node, "import")).toEqual(["data-note"]);
  });

  it("should keep semantic attributes when preset is import", () => {
    const node = element("a", [
      ["id", "anchor"],
      ["class", "ref"],
      ["title", "题注"],
      ["href", "#x"],
      ["data-note", "y"],
      ["aria-label", "z"],
    ]);
    expect(attrNamesOf(node, "import")).toEqual([
      "id",
      "class",
      "title",
      "href",
      "data-note",
      "aria-label",
    ]);
  });
});

describe("两个预设的差异哨兵", () => {
  // print 是逐字节冻结契约；这几条把"import 比 print 严"的边界钉在测试里。
  it("should keep uppercase ON* for print but strip it for import", () => {
    const node = element("svg", [["ONCLICK", "alert(1)"]]);
    expect(attrNamesOf(node, "print")).toEqual(["ONCLICK"]);
    expect(attrNamesOf(node, "import")).toEqual([]);
  });

  it("should drop contenteditable element for print but keep it stripped for import", () => {
    const node = element("p", [["contenteditable", "true"]]);
    expect(isDroppedNode(node, "print")).toBe(true);
    expect(isDroppedNode(node, "import")).toBe(false);
    expect(attrNamesOf(node, "import")).toEqual([]);
  });

  it("should keep benign style for print but strip it for import", () => {
    const node = element("p", [["style", "color: red"]]);
    expect(attrNamesOf(node, "print")).toEqual(["style"]);
    expect(attrNamesOf(node, "import")).toEqual([]);
  });

  it("should keep data:text/plain link for print but strip it for import", () => {
    const node = element("a", [["href", "data:text/plain,hi"]]);
    expect(attrNamesOf(node, "print")).toEqual(["href"]);
    expect(attrNamesOf(node, "import")).toEqual([]);
  });

  it("should strip whitespace-obfuscated javascript: for import but not print", () => {
    // print 的历史口径只剥 ≤0x20：NEL/NBSP 在它眼里不是可剥字符（冻结行为）
    const node = element("a", [["href", "java\u0085script:alert(1)"]]);
    expect(attrNamesOf(node, "print")).toEqual(["href"]);
    expect(attrNamesOf(node, "import")).toEqual([]);
  });
});

describe("通用判定", () => {
  it("should count img and svg image as dropped images", () => {
    expect(isCountedImage(element("img"))).toBe(true);
    expect(isCountedImage(element("image"))).toBe(true);
    expect(isCountedImage(element("IMAGE"))).toBe(true);
    expect(isCountedImage(element("svg"))).toBe(false);
    expect(isCountedImage(element("picture"))).toBe(false);
  });

  it("should read the first matching attribute and miss cleanly", () => {
    const node = element("p", [
      ["id", "first"],
      ["id", "second"],
    ]);
    expect(attributeOf(node, "id")).toBe("first");
    expect(attributeOf(node, "missing")).toBeUndefined();
  });
});

describe("import 预设 · 端到端剥壳", () => {
  const cleaned = (node: HtmlElementNode): HtmlElementNode | undefined => {
    if (isDroppedNode(node, "import") || hasExternalResource(node, "import")) {
      return undefined;
    }
    return {
      ...node,
      attrs: sanitizedAttributesOf(node, "import"),
      children: node.children.flatMap<HtmlNode>((child) => {
        if (child.kind !== "element") {
          return [child];
        }
        const kept = cleaned(child);
        return kept === undefined ? [] : [kept];
      }),
    };
  };

  it("should reduce a hostile foreign document to safe semantic content", () => {
    const root = parseHtml(
      `<article data-hr-id="foreign">
        <h1 onclick="steal()">标题</h1>
        <p style="position:fixed">正文<a href="javascript:alert(1)">链接</a><a href="https://ok.example">好链接</a></p>
        <script>alert(1)</script><style>.x{}</style><iframe src="//evil.example"></iframe>
        <form><input value="x"></form>
        <svg onload="alert(2)"><script>alert(3)</script><foreignObject><p>嵌套</p></foreignObject><animate attributeName="href" values="javascript:x"/></svg>
        <img src="//evil.example/x.png"><img src="data:image/png;base64,AAAA" alt="内联">
        <template><script>alert(4)</script></template><noscript><p>提示</p></noscript>
      </article>`,
    ).root;
    const article = findElement(root, "article");
    if (article === undefined) {
      throw new Error("fixture 里必须有 <article>");
    }
    const kept = cleaned(article);
    if (kept === undefined) {
      throw new Error("<article> 不该被删");
    }
    const html = serializeHtml({ root: { kind: "document", children: [kept] }, diagnostics: [] });
    for (const gone of [
      "<script",
      "<style",
      "<iframe",
      "<form",
      "foreignObject",
      "<animate",
      "<template",
      "<noscript",
      "javascript:",
      "onclick",
      "onload",
      "contenteditable",
      "data-hr-",
      "evil.example",
      "style=",
      "steal()",
    ]) {
      expect(html).not.toContain(gone);
    }
    expect(html).toContain("标题");
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain("<svg");
    // 剥属性不剥节点：链接文字仍在
    expect(html).toContain(">链接</a>");
    expect(attributeValue(kept, "data-hr-id")).toBeUndefined();
  });
});
