import { injectNodeIds, parseHtml } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { printHtmlOf, printHtmlReportOf } from "../src/index";
import {
  anchorHrefsOfHtml,
  attrOf,
  classesOf,
  elementsOfHtml,
  fixtureOf,
  firstTagOf,
  idsOfHtml,
  inputOf,
  tagsOf,
} from "./support";

const source = fixtureOf("article-hr-id.html");
const input = inputOf(source);
const product = printHtmlOf(input);
const root = parseHtml(product).root;
const article = firstTagOf(root, "article");
const idsOf = elementsOfHtml(product).map((element) => attrOf(element, "data-hr-id"));

describe("data-hr-id 幂等（AC-12）", () => {
  it("源文档的合法 id 逐字保留", () => {
    for (const id of ["chapter-7", "doc-head", "legal-id", "sec-legal"]) {
      expect(idsOf).toContain(id);
    }
  });

  it("非法 id 由 core 改写并留 invalid_hr_id 诊断，产物里不再出现原值", () => {
    const diagnostics = injectNodeIds(parseHtml(source)).parsed.diagnostics;
    expect(diagnostics.map((item) => item.code)).toContain("invalid_hr_id");
    const heading = tagsOf(article, "h2")[0];
    expect(attrOf(heading ?? article, "data-hr-id")).toMatch(/^hr-[0-9a-f]{8}$/u);
    expect(product).not.toContain("bad id!");
  });

  it("编号按 core 改写后的 id 落到标题上，不因改写断链", () => {
    const heading = tagsOf(article, "h2")[0];
    expect(attrOf(heading ?? article, "id")).toMatch(/^sec-\d+(?:\.\d+)*$/u);
    expect(
      tagsOf(root, "li").filter((item) => attrOf(item, "data-toc-id") !== undefined).length,
    ).toBe(2);
  });
});

describe("chapter 只由 section 产生（§11.2）", () => {
  it("section 带 chapter 类", () => {
    const section = tagsOf(article, "section")[0];
    expect(classesOf(section ?? article)).toContain("chapter");
  });

  it("header 容器不带 chapter 类", () => {
    const header = tagsOf(article, "header")[0];
    expect(classesOf(header ?? article)).not.toContain("chapter");
  });
});

describe("生成锚不与既有 id 冲突（§13.1 / §10 裁定）", () => {
  it("源文档占用 sec-1 时，生成锚让位到 sec-1-2（与既有 id 不冲突）", () => {
    const html = printHtmlOf(
      inputOf('<article><h2>甲</h2><div id="sec-1">x</div><h2>乙</h2></article>'),
    );
    const ids = idsOfHtml(html);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("sec-1");
    expect(ids).toContain("sec-1-2");
  });

  it("源文档占用 hr-toc 时，目录容器的 id 也避让", () => {
    const html = printHtmlOf(inputOf('<article><p id="hr-toc">正文</p></article>'));
    expect(html).not.toContain('<nav class="toc" id="hr-toc">');
  });

  // 有意为之的已知行为（§10 裁定）：改写用户 id 会打断 `<a href="#x">` 的内部链接语义，
  // 而重复 id 本身就是非法 HTML——该修的是源文档，不是渲染层。口径仍是"生成锚不与既有 id 冲突"。
  it("source-duplicate-ids-are-preserved：源文档自带的重复 id 原样保留", () => {
    const html = printHtmlOf(
      inputOf('<article><h2>甲</h2><div id="dup">x</div><div id="dup">y</div></article>'),
    );
    const ids = idsOfHtml(html);
    expect(ids.filter((id) => id === "dup")).toHaveLength(2);
    // 生成锚照样避让：与 dup 无冲突即可，不要求全树唯一。
    expect(ids).toContain("sec-1");
  });

  it("目录链接指向真实存在的锚（避让后不产生死链）", () => {
    const html = printHtmlOf(
      inputOf('<article><div id="sec-1">x</div><h2>甲</h2><h2>乙</h2></article>'),
    );
    const ids = new Set(idsOfHtml(html));
    const hrefs = anchorHrefsOfHtml(html);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((href) => !ids.has(href))).toEqual([]);
  });
});

describe("字节数", () => {
  it("报告里的 bytes 等于产物的 UTF-8 字节数（AC-11 上限判据由调用方用）", () => {
    const report = printHtmlReportOf(input);
    expect(report.bytes).toBe(Buffer.byteLength(report.html, "utf8"));
    expect(report.bytes).toBeGreaterThan(report.html.length);
  });
});
