import { describe, expect, it } from "vitest";

import { parseHtml, serializeHtml } from "../src/index";

/** 卡片要求的不变式：树在 tag/attrs/children 上与首轮解析深度相等。 */
const roundTripRoot = (html: string): unknown => parseHtml(serializeHtml(parseHtml(html))).root;

const expectStable = (html: string): void => {
  const first = parseHtml(html);
  const reprinted = serializeHtml(first);
  const second = parseHtml(reprinted);

  expect(second.root).toEqual(first.root);
  expect(serializeHtml(second)).toBe(reprinted);
};

// 12 个我认为最狠的样本：每个都在踩 HTML 解析器的一个"会吃掉/改写东西"的角落。
const NASTY = {
  duplicateAndCase: '<article><div z="1" A="2" z="3" Data-X="y"><p>x</p></div></article>',
  voidsAndSelfClosing: '<article><p>a<br/>b<img src="x"/><hr/><input disabled></p></article>',
  rawText:
    '<article><script>if (a<b && c>d) { x="&amp;"; }</script><style>a>b{content:"&"}</style></article>',
  preWhitespace: "<article><pre>\n  a\n    b\n</pre></article>",
  entities: "<article><p>&amp; &lt; &gt; &quot; &apos; &nbsp; &#65; &#x42;</p></article>",
  doctypeIds:
    '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><article><!--c-->x</article>',
  template: "<article><template><p>t</p></template></article>",
  brokenNesting: "<article><p>a<p>b</div></article>",
  impliedTableCells: "<article><table><tr><td>a<td>b</table></article>",
  uppercaseUnicode: "<ARTICLE><SECTION><P>Ünïcode 😀 & <b>bold</b></SECTION></ARTICLE>",
  foreignContent: '<article><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></article>',
  metaWithScriptClose: '<article><p>x</p></article><script id="hr-meta">{"x":"</script>"}</script>',
  textareaRaw: "<article><textarea></div>&amp;</textarea></article>",
  // 真实文档（docs/02 §1 的骨架 + 真 meta JSON）：往返必须逐字稳定。
  realDocument: [
    "<!DOCTYPE html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>hReader</title></head><body><article>',
    '<section data-hr-id="sec-problem" data-hr-component="callout-warning"><h2 data-hr-id="h2-problem">为什么直觉上的主从复制一定会丢数据？</h2><p data-hr-id="p-problem-1">假设网络发生分区……</p></section>',
    '<section data-hr-id="sec-comparison" data-hr-component="kpi-bento"><h2>指标</h2><table><tr><td>a<td>b</table></section>',
    "</article>",
    '<script id="hr-meta" type="application/json">{"version":"1.0","annotations":[{"id":"ann-01","targetId":"p-problem-1","selectedText":"网络发生分区","comment":"用银行转账举例","status":"pending_ai"}]}</script>',
    "</body></html>",
  ].join(""),
} as const;

describe("往返不变式 parse(serialize(parse(x)))", () => {
  for (const [name, html] of Object.entries(NASTY)) {
    it(`should keep the tree stable for ${name}`, () => {
      expectStable(html);
      expect(roundTripRoot(html)).toEqual(parseHtml(html).root);
    });
  }
});

describe("往返 · 序列化不接受文档美化", () => {
  it("should not add whitespace or reindent a compact document", () => {
    const html =
      "<!DOCTYPE html><html><head><title>t</title></head><body><article><h1>a</h1><p>b</p></article></body></html>";

    expect(serializeHtml(parseHtml(html))).toBe(html);
  });

  it("should survive three consecutive round trips without drift", () => {
    let html: string = NASTY.entities;
    let printed = serializeHtml(parseHtml(html));

    for (let index = 0; index < 3; index += 1) {
      const parsed = parseHtml(html);
      const next = serializeHtml(parsed);
      expect(next).toBe(printed);
      html = next;
      printed = next;
    }
  });
});
