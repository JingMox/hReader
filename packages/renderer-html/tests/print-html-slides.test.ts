// Structural differences of the slides print sheet (no cover/TOC, 16:9 page frame, unnumbered titles); visual rendering is not verified here.

import { parseHtml } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { printHtmlReportOf } from "../src/index";
import { attrOf, classesOf, elementsOfHtml, inputOf, tagsOf } from "./support";

/** A slides document: the top-level h1 is the title page and each later page is one section (the `hr new --kind slides` shape). */
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

describe("printHtmlReportOf slides detection", () => {
  it("should report slides: true for data-hr-kind=slides and false for a normal document", () => {
    expect(slidesReport().slides).toBe(true);
    expect(printHtmlReportOf(inputOf("<article><h1>标题</h1><p>正文</p></article>")).slides).toBe(
      false,
    );
  });

  it("should not take the slides skeleton when data-hr-kind holds another value", () => {
    const report = printHtmlReportOf(
      inputOf('<article data-hr-kind="report"><h1>标题</h1><p>正文</p></article>'),
    );
    expect(report.slides).toBe(false);
    expect(report.html).toContain('class="cover"');
  });
});

describe("slides print sheet page furniture", () => {
  const { html } = slidesReport();
  const elements = elementsOfHtml(html);

  it('should emit no cover or TOC: one extra page would break the "PDF pages = slide count" promise', () => {
    expect(tagsOf(parseHtml(html).root, "nav")).toEqual([]);
    expect(elements.some((element) => classesOf(element).includes("cover"))).toBe(false);
  });

  it("should hard-code a 16:9 page frame: slides rejects --page-size and no template residue may appear in @page", () => {
    expect(html).toContain("size: 13.333in 7.5in;");
    expect(html).not.toContain("@@paper@@");
    expect(html).not.toContain("size: A4;");
  });

  it("should force pagination on every top-level slide element per the skeleton", () => {
    expect(html).toContain("article > section");
    expect(html).toContain("break-after: page;");
  });
});

describe("slides print sheet body rewriting", () => {
  const { html } = slidesReport();
  const elements = elementsOfHtml(html);

  it('should leave titles unnumbered and containers without the chapter class (no "1.2" prefix on page titles)', () => {
    expect(
      elements.some(
        (element) =>
          classesOf(element).includes("secnum") || classesOf(element).includes("chapter"),
      ),
    ).toBe(false);
  });

  it("should keep data-hr-kind on article so a theme's slides selector still recognizes it in the product", () => {
    const articles = elements.filter((element) => element.tag === "article");
    expect(articles.map((element) => attrOf(element, "data-hr-kind"))).toEqual(["slides"]);
  });
});
