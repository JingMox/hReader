// 这层管：`hr_outline` 的字数规则（卡片 M1.3 契约 3）；口径全部按卡片定义，不照抄实现值。

import { describe, expect, it } from "vitest";

import { buildOutline, parseHtml } from "../src/index";
import type { ParsedHtml } from "../src/index";

/** 正文一律放在 `<article>` 里：字数只统计 article 子树。 */
const articleOf = (body: string): string => `<article data-hr-id="art">${body}</article>`;

const parsedOf = (body: string): ParsedHtml => parseHtml(articleOf(body));

const wordsOf = (body: string): number => buildOutline(parsedOf(body)).wordCount;

interface WordCase {
  readonly name: string;
  readonly text: string;
  readonly expected: number;
  readonly why: string;
}

// 卡片 3：CJK（含扩展 A/B、假名、全角字母）每字符 1；连续拉丁/数字串每串 1；标点/空白 0。
const WORD_CASES: readonly WordCase[] = [
  { name: "纯中文", text: "分布式一致性", expected: 6, why: "每个汉字独立计 1" },
  { name: "纯英文", text: "distributed consensus protocol", expected: 3, why: "空格断串，3 串" },
  {
    name: "中英混排",
    text: "我用 PDF 阅读器读 raft 论文",
    expected: 10,
    why: "汉字 8 + PDF 1 + raft 1",
  },
  {
    name: "连字符复合词",
    text: "state-of-the-art",
    expected: 4,
    why: "`-` 不是字母数字，切成 4 串",
  },
  { name: "千分位小数", text: "1,234.56", expected: 3, why: "`,`/`.` 断串：1 / 234 / 56" },
  // v2 #13 追加：撇号/中点都是分隔符。
  { name: "撇号缩写", text: "l'été", expected: 2, why: "`'` 断串：l / été" },
  { name: "单码点 emoji", text: "😀", expected: 0, why: "emoji 不是 L/N，也不属 CJK" },
  { name: "ZWJ 家庭 emoji", text: "👨‍👩‍👧‍👦", expected: 0, why: "连接符与 emoji 都不计字" },
  { name: "CJK 扩展 B", text: "𠀀𠀁", expected: 2, why: "astral 汉字按 1 个码点计" },
  // 卡片 v2 #13 已裁定：只有 CJK（Han/假名/谚文）逐字符计 1，其余字母（含全角 Ａ = Script=Latin、
  // 希腊、西里尔、带变音符字母）一律"整串 1"。所以这条不再是缺陷（D6 已由 v2 关闭）。
  {
    name: "全角字母",
    text: "ＡＢＣ",
    expected: 1,
    why: "v2 #13：全角 Ａ 属 Script=Latin，非 CJK → 整串 1",
  },
  { name: "假名", text: "ひらがな", expected: 4, why: "假名属 CJK 计数范围，逐字符 1" },
  { name: "希伯来 RTL", text: "שלום", expected: 1, why: "RTL 不影响计数；非 CJK 字母连串算 1 词" },
  { name: "阿拉伯 RTL", text: "مرحبا", expected: 1, why: "同上；阿拉伯字母不是 CJK，按连串计 1" },
  { name: "纯标点", text: "，。！？；：", expected: 0, why: "标点计 0" },
  { name: "空串", text: "", expected: 0, why: "空文本 0 字" },
];

describe("hr_outline · 字数规则", () => {
  for (const testCase of WORD_CASES) {
    it(`should count ${testCase.name} as ${String(testCase.expected)} (${testCase.why})`, () => {
      expect(wordsOf(`<p>${testCase.text}</p>`)).toBe(testCase.expected);
    });
  }

  it("should treat NFC and NFD of the same letter as the same count", () => {
    const composed = "é";
    const decomposed = "e\u0301";

    expect(Array.from(composed).length).not.toBe(Array.from(decomposed).length);
    expect(wordsOf(`<p>${composed}</p>`)).toBe(1);
    expect(wordsOf(`<p>${decomposed}</p>`)).toBe(1);
  });

  it("should count text inside <code> and <pre> as content", () => {
    expect(wordsOf("<pre>raft leader</pre><code>leader == proposer</code>")).toBe(4);
  });

  // D2（已登记，见报告）：拉丁串被内联标签切断时，`countWords` 按文本节点分别起算，一个词变两个。
  // KD-03
  it.fails("should count a latin run split by inline markup once (spec: 连续串 = 1)", () => {
    expect(wordsOf("<p>distri<b>buted</b></p>")).toBe(1);
  });

  // 同一缺陷的现状钉子：将来实现修好后这条会红，提醒把上一条 `it.fails` 一起翻牌。
});
describe("hr_outline · 字数规则 · 续 1", () => {
  it("should expose the current double-count of a markup-split latin run (D2 pin)", () => {
    expect(wordsOf("<p>distri<b>buted</b></p>")).toBe(2);
  });

  it("should keep CJK counting stable when inline markup splits a word", () => {
    expect(wordsOf("<p>分<b>布</b>式</p>")).toBe(3);
  });

  // 我最初把这里判成缺陷（"script 文本被计字"），复验后**撤回**：`NON_VISIBLE_TEXT_TAGS`
  // 已排除 script/style/template/title 等，字数只来自可见文本。
  it("should ignore script/style/template/textarea text in wordCount", () => {
    expect(
      wordsOf(
        '<script id="hr-meta">{"annotations":[]}</script><style>p{color:red}</style>' +
          "<template><p>hidden</p></template>" +
          "<textarea>text area words</textarea><p>正文</p>",
      ),
    ).toBe(2);
  });

  // v2 #12：`<noscript>` 是兜底可见内容，必须计字（脚本禁用时用户真的会看到它）。
  it("should count <noscript> text as visible content", () => {
    expect(wordsOf("<noscript>需要启用脚本</noscript><p>正文</p>")).toBe(8);
  });

  // D7（已登记）：`<title>` 不在 `NON_VISIBLE_TEXT_TAGS` 里，它的文本会被计入字数。
  // 在 `hr_outline` 场景下 article 里出现 `<title>` 很罕见，故只钉现状、不判缺陷。
  it("should count <title> text as visible content (pin)", () => {
    expect(wordsOf("<title>t</title><p>正文</p>")).toBe(3);
  });
});
describe("hr_outline · 字数规则 · 续 2", () => {
  it("should not let the hr-meta JSON inflate wordCount", () => {
    const metaJson =
      '{"annotations":[{"id":"ann-01","targetId":"sec-problem","comment":"","status":"pending_ai"}]}';

    expect(wordsOf(`<script id="hr-meta">${metaJson}</script><p>正文</p>`)).toBe(2);
  });
});

// 组合附标：`é` 的 NFC/NFD 同值已在上面覆盖；这里补"NFC 之后仍然残留的附标"（q + U+0301 无预组合形式）
// 与"孤立附标"，防止 `\p{M}` 分支被漏测（覆盖率里 `COMBINING_MARK.test` 的 continue 就是这两条打到的）。
describe("hr_outline · 字数 · 组合附标边界", () => {
  it("should not count a combining mark that survives NFC as its own word", () => {
    expect(wordsOf("<p>q\u0301</p>")).toBe(1);
    expect(wordsOf("<p>\u0301</p>")).toBe(0);
  });

  it("should give the same count for NFC and NFD spellings", () => {
    expect(wordsOf("<p>e\u0301</p>")).toBe(wordsOf("<p>\u00E9</p>"));
  });
});
