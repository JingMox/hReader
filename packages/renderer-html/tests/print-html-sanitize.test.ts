import { parseHtml } from "@hreader/core";
import type { HtmlElementNode, HtmlNode } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { printHtmlReportOf } from "../src/index";
import {
  attrOf,
  classesOf,
  elementsOf,
  fixtureOf,
  firstTagOf,
  inputOf,
  tagsOf,
  textOf,
} from "./support";

const report = printHtmlReportOf(inputOf(fixtureOf("article-noisy.html")));
const root = parseHtml(report.html).root;
const article = firstTagOf(root, "article");
const inside = elementsOf(article);

const RESOURCE_ATTRIBUTES = ["src", "srcset", "poster"] as const;

const valuesOf = (node: HtmlNode, name: string): readonly string[] =>
  elementsOf(node).flatMap((element) => {
    const value = attrOf(element, name);
    return value === undefined ? [] : [value];
  });

/** 取"最内层"命中元素：`<p><a>文本</a></p>` 要找的是 `<a>`，不是外层 `<p>`/`<article>`。 */
const elementWithText = (node: HtmlNode, text: string): HtmlElementNode | undefined => {
  const matches = elementsOf(node).filter((element) => textOf(element).includes(text));
  return matches[matches.length - 1];
};

describe("D9 交互 UI 与外部媒体：整节点删除", () => {
  it.each([
    "script",
    "style",
    "link",
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
  ])("<%s> 在正文里一个都不剩", (tag) => {
    expect(tagsOf(article, tag)).toEqual([]);
  });

  it("UI 类名、data-hr-ui、contenteditable 的节点都不进产物", () => {
    expect(
      inside.filter((element) => classesOf(element).some((token) => token.startsWith("hr-"))),
    ).toEqual([]);
    expect(inside.filter((element) => attrOf(element, "data-hr-ui") !== undefined)).toEqual([]);
    expect(inside.filter((element) => attrOf(element, "contenteditable") !== undefined)).toEqual(
      [],
    );
  });

  it("产物是树级删除，不是 CSS 隐藏（HTML 里搜不到 script 标签）", () => {
    expect(report.html).not.toContain("<script");
    expect(report.html).not.toContain("<iframe");
  });
});

describe("SVG 资源元素与 head 样式范围", () => {
  it("image/use/feImage 整删（不做 href 白名单，同文档 #symbol 也不留）", () => {
    // 先证明"看得见"：parse5 在 SVG 语境保留驼峰，若 helper 严格比对，下面那条 0 断言会恒绿（§13.7）。
    // 整删 `<svg>` 之后产物里本来就没有 feImage，光断 0 两条都瞎。
    const source = firstTagOf(parseHtml(fixtureOf("article-noisy.html")).root, "article");
    expect(tagsOf(source, "feImage").length).toBe(1);
    expect(tagsOf(source, "feimage").length).toBe(1);
    expect(tagsOf(source, "FEIMAGE").length).toBe(1);
    expect(tagsOf(article, "feImage").length).toBe(0);
    for (const tag of ["image", "use", "feimage"]) {
      expect(tagsOf(article, tag)).toEqual([]);
      expect(tagsOf(article, tag.toUpperCase())).toEqual([]);
    }
  });

  it("head 里我们自己的两份 <style>（主题 + 印刷骨架）不算违规（AC-7 只看正文）", () => {
    expect(tagsOf(root, "style").length).toBe(2);
    expect(tagsOf(article, "style").length).toBe(0);
  });
});

describe("XSS：事件属性与伪协议", () => {
  it("所有 on* 事件属性都被剥离（含 svg onload）", () => {
    const handlers = inside.flatMap((element) =>
      element.attrs.filter(([name]) => name.startsWith("on")),
    );
    expect(handlers).toEqual([]);
    expect(report.html).not.toContain("alert(1)");
  });

  it("javascript:/vbscript:/data:text/html 的链接只丢属性，正文链接文字保留", () => {
    const dangerous = valuesOf(article, "href").concat(valuesOf(article, "xlink:href"));
    expect(
      dangerous.filter((value) => /^(?:javascript|vbscript|data:text\/html)/iu.test(value.trim())),
    ).toEqual([]);
    const bad = elementWithText(article, "坏链接");
    expect(bad?.tag).toBe("a");
    expect(attrOf(bad ?? firstTagOf(article, "p"), "href")).toBeUndefined();
    expect(elementWithText(article, "数据链接")?.tag).toBe("a");
  });

  it("正常的 https 链接原样保留", () => {
    const good = elementWithText(article, "好链接");
    expect(good?.tag).toBe("a");
    expect(attrOf(good ?? firstTagOf(article, "p"), "href")).toBe("https://example.com/x");
  });

  it("style 里的外链 url() 被丢掉，整个 style 属性不留", () => {
    const styled = elementWithText(article, "带外链样式的段落");
    expect(styled?.tag).toBe("p");
    expect(attrOf(styled ?? firstTagOf(article, "p"), "style")).toBeUndefined();
  });
});

describe("外部资源：只放行内联 data:image", () => {
  it("相对路径与 http(s) 的图片整体删除，并把数量报给调用方", () => {
    expect(tagsOf(article, "img").length).toBe(1);
    // 口径只数图片：`<img src="x.png">` 与 SVG `<image>` 各一；`<svg>`/`<use>`/`<feImage>` 不计（§13.3）。
    expect(report.droppedImages).toBe(2);
    expect(elementWithText(article, "相对路径图")).toBeUndefined();
  });

  it("data:image 图片保留 src", () => {
    const inline = firstTagOf(article, "img");
    expect(attrOf(inline, "src")).toMatch(/^data:image\//u);
    expect(attrOf(inline, "alt")).toBe("内联图");
  });

  it("src/srcset/poster 里只剩内联 data:image，没有 http(s) 资源", () => {
    const resources = RESOURCE_ATTRIBUTES.flatMap((name) => valuesOf(article, name));
    expect(resources.filter((value) => value.trim().startsWith("http"))).toEqual([]);
    expect(resources.filter((value) => !value.trim().startsWith("data:image/"))).toEqual([]);
    expect(resources).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
  });

  it("SVG 本体保留，但事件属性随 on* 规则去掉", () => {
    expect(tagsOf(article, "svg").length).toBe(1);
  });
});

describe("srcset 多候选（§13.7 的 M9 盲点）", () => {
  const srcsetReport = printHtmlReportOf(inputOf(fixtureOf("article-srcset.html")));
  const srcsetArticle = firstTagOf(parseHtml(srcsetReport.html).root, "article");
  const alts = tagsOf(srcsetArticle, "img").map((image) => attrOf(image, "alt"));

  it("候选全是内联 data:image 时整张保留", () => {
    expect(alts).toContain("全内联候选");
  });

  it("候选里只要有一个外链，整张图删掉并计数", () => {
    expect(alts).not.toContain("混外链候选");
    expect(srcsetReport.droppedImages).toBe(1);
    expect(srcsetArticle).not.toContain("cdn.example");
  });
});

describe("干净文档不该被误删", () => {
  const clean = printHtmlReportOf(inputOf(fixtureOf("article.html")));

  it("无外部资源时不报删除数", () => {
    expect(clean.droppedImages).toBe(0);
  });

  it("正文段落与容器结构完整", () => {
    const cleanRoot = parseHtml(clean.html).root;
    expect(tagsOf(cleanRoot, "p").length).toBeGreaterThan(4);
    expect(tagsOf(cleanRoot, "section").length).toBe(4);
  });
});
