import { describe, expect, it } from "vitest";

import { parseHtml } from "../src/index";
import { codesOf, messagesOf } from "./html-support.test";

const codesFor = (html: string): readonly string[] => codesOf(parseHtml(html));

describe("balance · 未闭合", () => {
  it("should report elements left open at EOF in document order", () => {
    const parsed = parseHtml("<div><span>x");

    expect(codesOf(parsed)).toEqual(["unclosed_tag", "unclosed_tag"]);
    expect(messagesOf(parsed)).toEqual(["<div> 到文档结束仍未闭合", "<span> 到文档结束仍未闭合"]);
  });

  it("should not report optional end tags left open at EOF", () => {
    expect(codesFor("<section><p>a")).toEqual(["unclosed_tag"]);
    expect(codesFor("<table><caption>c")).toEqual(["unclosed_tag"]);
    expect(codesFor("<ul><li>a")).toEqual(["unclosed_tag"]);
    expect(messagesOf(parseHtml("<table><caption>c"))).toEqual(["<table> 到文档结束仍未闭合"]);
  });

  it("should not report a p implied-closed by the next block starter", () => {
    expect(codesFor("<p>a<div>b</div>")).toEqual([]);
    expect(codesFor("<p>a<table><tr><td>c</td></tr></table>")).toEqual([]);
  });

  it("should report only the really-unclosed tag when an implied close happens", () => {
    expect(codesFor("<p>a<div>")).toEqual(["unclosed_tag"]);
  });
});

describe("balance · 错嵌套", () => {
  it("should report each element force-closed by an outer end tag", () => {
    const parsed = parseHtml("<div><span><b></div>");

    expect(codesOf(parsed)).toEqual(["misnested_tag", "misnested_tag"]);
    expect(messagesOf(parsed)).toEqual([
      "<span> 被 </div> 强行闭合，属于错嵌套",
      "<b> 被 </div> 强行闭合，属于错嵌套",
    ]);
  });

  it("should report an end tag with no matching start tag", () => {
    const parsed = parseHtml("<div>x</span></div>");

    expect(codesOf(parsed)).toEqual(["misnested_tag"]);
    expect(messagesOf(parsed)[0]).toBe("<span> 的结束标签没有对应的开始标签");
  });

  it("should ignore an end tag for a void element", () => {
    expect(codesFor("<p>a</br>b</p>")).toEqual([]);
    expect(codesFor("<p>a</img>b</p>")).toEqual([]);
  });

  it("should lowercase closing tags before matching", () => {
    expect(codesFor("<div>x</DIV>")).toEqual([]);
    expect(codesFor("<DIV>x</Div>")).toEqual([]);
  });
});

// R1 已修（impl-M1.1.md §9 D2）：closeTag 现在只对 FORMATTING_TAGS（adoption-agency 那一组）
// 报 misnested，非格式化元素被外层结束标签收尾时静默。这正是测试的意图：合法隐式闭合
// （<ul><li>…</ul>、<table><tr><td>…</table>）不再当噪音，而真交叉嵌套（<div><span><b></div>）
// 仍要报。这 5 条曾经全部红过（当时用 it.fails 钉住 bug），如今应绿：已翻成 it。
describe("balance · 合法隐式闭合不再报噪音（D2 已修）", () => {
  it("should stay quiet for <ul><li>a</ul>", () => {
    expect(codesFor("<ul><li>a</ul>")).toEqual([]);
  });

  it("should stay quiet for <table><tr><td>a<td>b</table>", () => {
    expect(codesFor("<table><tr><td>a<td>b</table>")).toEqual([]);
  });

  it("should stay quiet for <select><option>a<option>b</select>", () => {
    expect(codesFor("<select><option>a<option>b</select>")).toEqual([]);
  });

  it("should stay quiet for <dl><dt>a<dd>b</dl>", () => {
    expect(codesFor("<dl><dt>a<dd>b</dl>")).toEqual([]);
  });

  it("should stay quiet for <section><h1>t</section>", () => {
    expect(codesFor("<section><h1>t</section>")).toEqual([]);
  });
});

describe("balance · 原文剥离（raw text / 注释 / bang）", () => {
  it("should not see markup inside script without attributes", () => {
    expect(codesFor('<script>var a = "</div>";</script>')).toEqual([]);
  });

  it("should not see markup inside script with attributes", () => {
    expect(codesFor('<script type="module">var a = "</div>";</script>')).toEqual([]);
  });

  it("should strip every other raw-text element too", () => {
    expect(codesFor("<textarea></div></textarea>")).toEqual([]);
    expect(codesFor("<title></div></title>")).toEqual([]);
    expect(codesFor("<style>a::after{content:'</div>'}</style>")).toEqual([]);
    expect(codesFor("<iframe></div></iframe>")).toEqual([]);
  });

  it("should strip comments before pairing", () => {
    expect(codesFor("<div><!-- </div> -->x</div>")).toEqual([]);
  });

  it("should strip doctype and other bang constructs before pairing", () => {
    expect(codesFor("<!DOCTYPE html><div>x</div>")).toEqual([]);
  });

  it("should not be fooled by > or < inside quoted attribute values", () => {
    expect(codesFor('<div title="a>b">x</div>')).toEqual([]);
    expect(codesFor("<div title='a>b'>x</div>")).toEqual([]);
    expect(codesFor('<div title="a<b">x</div>')).toEqual([]);
  });
});

describe("balance · 与 parse5 的判据分工", () => {
  it("should stay quiet on a well-formed real document", () => {
    const html = [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="utf-8"><title>t</title></head>',
      "<body><article><h1>a</h1><section><p>x</p><ul><li>y</li></ul></section></article></body>",
      "</html>",
    ].join("");

    expect(codesFor(html)).toEqual([]);
  });
});
