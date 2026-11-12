import { describe, expect, it } from "vitest";

import { RAW_TEXT_TAGS } from "../src/html/constants";
import { parseHtml, serializeHtml } from "../src/index";
import { codesOf, messagesOf } from "./html-support.test";

// R2 把"合法隐式闭合"的判据收窄成白名单父链（`LEGAL_PARENTS`：td/th→tr，tr→table/tbody/thead/tfoot）。
// 本文件是那两张面的回归闸：放行侧必须静默，诊断侧必须报且只报该报的。全部走 parseHtml
// （对外行为），不直接调 balance 内部函数。

const BODY = (inner: string): string =>
  `<!DOCTYPE html><html><head></head><body>${inner}</body></html>`;
const codesFor = (html: string): readonly string[] => codesOf(parseHtml(html));
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

describe("noscript · R2 P1-R1 的实体只转义一次", () => {
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
