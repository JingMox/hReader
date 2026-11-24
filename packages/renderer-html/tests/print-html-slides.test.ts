// 这层管：slides 形态打印稿的结构差异（无封面/目录、16:9 页框、标题不编号）；不验视觉渲染。

import { parseHtml } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { printHtmlReportOf } from "../src/index";
import { attrOf, classesOf, elementsOfHtml, inputOf, tagsOf } from "./support";

/** slides 文档：顶层 h1 是标题页，之后每页一个 section（`hr new --kind slides` 的形状）。 */
const SLIDES_DOC = [
  "<!doctype html>",
  "<html><body>",
  '<article data-hr-kind="slides">',
  "<h1>复盘：一次发布</h1>",
  "<section><h2>先看三个数字</h2><p>要点</p></section>",
  "<section><h2>代价</h2><p>要点</p></section>",
  "</article>",
  "</body></html>",
].join("\n");

const slidesReport = () => printHtmlReportOf(inputOf(SLIDES_DOC));

describe("printHtmlReportOf · slides 判定", () => {
  it("data-hr-kind=slides 的产物标 slides: true，普通文档标 false", () => {
    expect(slidesReport().slides).toBe(true);
    expect(printHtmlReportOf(inputOf("<article><h1>标题</h1><p>正文</p></article>")).slides).toBe(
      false,
    );
  });

  it("data-hr-kind 取别的值不走 slides 骨架", () => {
    const report = printHtmlReportOf(
      inputOf('<article data-hr-kind="report"><h1>标题</h1><p>正文</p></article>'),
    );
    expect(report.slides).toBe(false);
    expect(report.html).toContain('class="cover"');
  });
});

describe("slides 打印稿 · 页家具", () => {
  const { html } = slidesReport();
  const elements = elementsOfHtml(html);

  it("没有封面与目录：多一页就让“PDF 页数 = slide 数”失约", () => {
    expect(tagsOf(parseHtml(html).root, "nav")).toEqual([]);
    expect(elements.some((element) => classesOf(element).includes("cover"))).toBe(false);
  });

  it("页框写死 16:9：slides 不接受 --page-size，@page 里不许出现模板残留", () => {
    expect(html).toContain("size: 13.333in 7.5in;");
    expect(html).not.toContain("@@paper@@");
    expect(html).not.toContain("size: A4;");
  });

  it("顶层 slide 元素按骨架强制分页", () => {
    expect(html).toContain("article > section");
    expect(html).toContain("break-after: page;");
  });
});

describe("slides 打印稿 · 正文改写", () => {
  const { html } = slidesReport();
  const elements = elementsOfHtml(html);

  it("标题不带章节序号，容器不带 chapter 类（页标题不该出现“1.2”前缀）", () => {
    expect(
      elements.some(
        (element) =>
          classesOf(element).includes("secnum") || classesOf(element).includes("chapter"),
      ),
    ).toBe(false);
  });

  it("article 保留 data-hr-kind：主题的 slides 分叉选择器要在产物里还认得它", () => {
    const articles = elements.filter((element) => element.tag === "article");
    expect(articles.map((element) => attrOf(element, "data-hr-kind"))).toEqual(["slides"]);
  });
});
