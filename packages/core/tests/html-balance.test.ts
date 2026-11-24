import { describe, expect, it } from "vitest";

import { RAW_TEXT_TAGS } from "../src/html/constants";
import { parseHtml, serializeHtml } from "../src/index";
import { codesOf, messagesOf } from "./html-support";

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

// closeTag 只对 FORMATTING_TAGS（adoption-agency 那一组）
// 报 misnested，非格式化元素被外层结束标签收尾时静默。这正是测试的意图：合法隐式闭合
// （<ul><li>…</ul>、<table><tr><td>…</table>）不再当噪音，而真交叉嵌套（<div><span><b></div>）
// 仍要报。这 5 条曾经全部红过（当时用 it.fails 钉住 bug），如今应绿：已翻成 it。
describe("balance · 合法隐式闭合不再报噪音", () => {
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

const BODY = (inner: string): string =>
  `<!DOCTYPE html><html><head></head><body>${inner}</body></html>`;
const messagesFor = (html: string): readonly string[] => messagesOf(parseHtml(html));

describe("balance · 单元格三兄弟的合法父链必须静默", () => {
  it("should stay quiet for table>tbody>tr>td", () => {
    expect(codesFor("<table><tbody><tr><td>x</table>")).toEqual([]);
  });

  it("should stay quiet for table>tr>td with the implied tbody", () => {
    // 源码层 `<table><tr>` 合法，合成 tbody 是解析器的事——这里若报错，等于把规范行为判成缺陷。
    expect(codesFor("<table><tr><td>x</table>")).toEqual([]);
  });

  it("should stay quiet for thead>tr>th", () => {
    expect(codesFor("<table><thead><tr><th>x</table>")).toEqual([]);
  });

  it("should stay quiet for tfoot>tr>td", () => {
    expect(codesFor("<table><tfoot><tr><td>x</table>")).toEqual([]);
  });

  it("should stay quiet for sibling cells closed implicitly by the next <td>", () => {
    expect(codesFor("<table><tbody><tr><td>a<td>b</tbody></table>")).toEqual([]);
  });

  it("should stay quiet when every end tag is explicit", () => {
    expect(codesFor("<table><tr><td>x</td></tr></table>")).toEqual([]);
  });
});

describe("balance · 非法父链必须报 error 且点名父元素", () => {
  it("should report table>td and name the real parent", () => {
    const parsed = parseHtml("<table><td>x</table>");

    expect(codesOf(parsed)).toEqual(["misnested_tag"]);
    expect(parsed.diagnostics[0]?.severity).toBe("error");
    expect(messagesOf(parsed)).toEqual([
      "<td> 的父元素是 <table>，应为 <tr>；被 </table> 强行闭合",
    ]);
  });

  it("should report table>th through the sibling branch", () => {
    expect(messagesFor("<table><th>x</table>")).toEqual([
      "<th> 的父元素是 <table>，应为 <tr>；被 </table> 强行闭合",
    ]);
  });

  it("should report a td parented directly by a div", () => {
    expect(messagesFor("<div><td>x</div>")).toEqual([
      "<td> 的父元素是 <div>，应为 <tr>；被 </div> 强行闭合",
    ]);
  });

  it("should report a tr parented by a div and list all legal parents", () => {
    // 同一强制收尾里 td 的父是 tr（合法）→ 只报 tr 一条；`expected` 是全表枚举，顺序即声明顺序。
    expect(messagesFor("<div><tr><td>x</div>")).toEqual([
      "<tr> 的父元素是 <div>，应为 <table>/<tbody>/<thead>/<tfoot>；被 </div> 强行闭合",
    ]);
  });
});

describe("balance · 父链合法但整体仍是错嵌套", () => {
  it("should blame only the formatting element when the cells are legal", () => {
    const parsed = parseHtml("<table><tr><td><div><b>x</table>");

    // td/tr 父链合法 → 不该被点名；<b> 被 </table> 收尾 → 恰一条。
    expect(codesOf(parsed)).toEqual(["misnested_tag"]);
    expect(messagesOf(parsed)).toEqual(["<b> 被 </table> 强行闭合，属于错嵌套"]);
  });
});

describe("noscript · 实体只转义一次", () => {
  it("should round trip noscript text byte for byte", () => {
    const source = BODY("<noscript>a &amp; b</noscript>");

    // 旧实现（noscript 在 RAW_TEXT_TAGS 且 parse5 默认 scripting:true）会产出 `a &amp;amp; b`。
    expect(serializeHtml(parseHtml(source))).toBe(source);
  });

  it("should keep elements inside noscript as elements", () => {
    expect(serializeHtml(parseHtml(BODY("<noscript><p>x</p></noscript>")))).toBe(
      BODY("<noscript><p>x</p></noscript>"),
    );
  });

  it("should not list noscript as raw text any more", () => {
    expect(RAW_TEXT_TAGS.has("noscript")).toBe(false);
    expect(RAW_TEXT_TAGS.has("script")).toBe(true);
  });
});
