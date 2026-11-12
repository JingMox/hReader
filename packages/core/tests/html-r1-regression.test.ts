import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_SEVERITY, RAW_TEXT_TAGS } from "../src/html/constants";
import { stableHex8 } from "../src/html/hash";
import { injectNodeIds, parseHtml, serializeHtml } from "../src/index";
import { codesOf, findElement, messagesOf } from "./html-support.test";

// 这层管：G3.1 R1 返工项的回归闸——每块对应 impl-M1.1.md §9 的一项修复，且都是"修前必红"的形状。

const BODY = (inner: string): string =>
  `<!DOCTYPE html><html><head></head><body>${inner}</body></html>`;
const ARTICLE = (inner: string): string => BODY(`<article>${inner}</article>`);
const roundPrint = (html: string): string => serializeHtml(parseHtml(html));
const codesFor = (html: string): readonly string[] => codesOf(parseHtml(html));

const ASTRAL_SAMPLES: readonly string[] = [
  "😀",
  "😁",
  "😂",
  "😃",
  "😄",
  "😅",
  "😆",
  "😇",
  "😈",
  "😉",
  "😊",
  "😋",
  "😌",
  "😍",
  "😎",
  "😏",
  "😐",
  "😑",
  "😒",
  "😓",
];

describe("hash · 代理对不再共享同一段哈希", () => {
  it("should give distinct hex8 for two astral chars sharing a surrogate", () => {
    // 旧实现按 UTF-16 单元逐位混入时高位代理相同、低位差异被后续乘法吞掉 → 两者同值。
    expect(stableHex8("😀")).not.toBe(stableHex8("😁"));
  });

  it("should keep 20 consecutive astral chars collision free", () => {
    const hashed = new Set(ASTRAL_SAMPLES.map((sample) => stableHex8(sample)));

    expect(hashed.size).toBe(ASTRAL_SAMPLES.length);
  });

  it("should stay deterministic and eight lowercase hex digits", () => {
    expect(stableHex8("😀")).toBe(stableHex8("😀"));
    expect(stableHex8("@hreader:😀")).toMatch(/^[0-9a-f]{8}$/u);
  });
});

describe("inject · 深嵌套耗时近似线性", () => {
  const nested = (depth: number): string =>
    ARTICLE(`${"<div>".repeat(depth)}x${"</div>".repeat(depth)}`);
  const timeOnce = (depth: number): number => {
    const html = nested(depth);
    const started = performance.now();
    injectNodeIds(parseHtml(html));
    return performance.now() - started;
  };
  const best = (depth: number): number =>
    Math.min(timeOnce(depth), timeOnce(depth), timeOnce(depth));

  it("should scale linearly between 500 and 4000 nesting levels", () => {
    // 深度调大 8 倍：线性 ≈8×，任何 O(n²) 的"逐层重扫"会到 ≈64×。
    const shallow = Math.max(best(500), 1);
    const deep = best(4000);

    expect(deep / shallow).toBeLessThan(16);
    expect(deep).toBeLessThan(2000);
  });

  it("should inject an id into every nested <div> regardless of depth", () => {
    const injected = injectNodeIds(parseHtml(nested(4000)));
    let cursor = findElement(injected.parsed.root, "article");
    let levels = 0;
    while (cursor !== undefined && levels < 4000) {
      const inner = findElement(cursor, "div");
      if (inner === undefined) {
        break;
      }
      levels += 1;
      cursor = inner;
    }

    expect(levels).toBe(4000);
  });
});

describe("serialize · raw text 清单与浏览器一致", () => {
  const RAW_SAMPLE = "<b>&amp;</b>";

  it.each([...RAW_TEXT_TAGS])("should keep %s content unescaped on a round trip", (tag) => {
    const source = BODY(`<${tag}>${RAW_SAMPLE}</${tag}>`);

    // 少一个 tag 在清单里 → 它会被当普通元素转义成 &lt;b&gt;，字符串立刻不等。
    expect(roundPrint(source)).toBe(source);
  });

  it("should still escape RCDATA contents exactly once", () => {
    // RCDATA 里 `</b>` 是字面文本而不是标签，所以解析后内容为 <b>&</b>，序列化只转义一次。
    expect(roundPrint(BODY("<textarea><b>&amp;</b></textarea>"))).toBe(
      BODY("<textarea>&lt;b&gt;&amp;&lt;/b&gt;</textarea>"),
    );
  });

  it("should not count script and style as escapable again", () => {
    expect(RAW_TEXT_TAGS.has("script")).toBe(true);
    expect(RAW_TEXT_TAGS.has("div")).toBe(false);
  });
});

describe("meta · 只认 script#hr-meta", () => {
  it("should not treat a div#hr-meta as the metadata script", () => {
    // 旧实现按"任意元素带 id=hr-meta"收，div 里放非 JSON 正文会误报 script_in_meta。
    expect(codesFor(BODY('<div id="hr-meta">not json</div>'))).toEqual([]);
  });

  it("should still flag a script#hr-meta whose JSON was truncated", () => {
    expect(codesFor(BODY('<script id="hr-meta">{"a":1</script>'))).toEqual(["script_in_meta"]);
  });
});

describe("diagnostic · severity 与标签命名", () => {
  it("should actually emit the error tier for misnesting", () => {
    const parsed = parseHtml("<div><span><b></div>");

    expect(parsed.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(["error", "error"]);
    expect(DIAGNOSTIC_SEVERITY.misnested_tag).toBe("error");
  });

  it("should keep the warning tier populated too", () => {
    const parsed = parseHtml("<div><span>x");

    expect(parsed.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
      "warning",
      "warning",
    ]);
  });

  it("should name the unmatched end tag, not its start tag", () => {
    // 旧实现把 message 里的标签名取成栈顶（开始标签），错标签诊断于是报了别的名字。
    expect(messagesOf(parseHtml("<div>x</span></div>"))).toEqual([
      "<span> 的结束标签没有对应的开始标签",
    ]);
  });

  it("should name the outer end tag in force-close messages", () => {
    expect(messagesOf(parseHtml("<div><span><b></div>"))).toEqual([
      "<span> 被 </div> 强行闭合，属于错嵌套",
      "<b> 被 </div> 强行闭合，属于错嵌套",
    ]);
  });
});

describe("balance · 修噪声没有把真问题一起修掉", () => {
  it("should still report cross-nested formatting elements", () => {
    expect(codesFor("<div><b><i></div>")).toEqual(["misnested_tag", "misnested_tag"]);
  });

  it("should document the remaining heuristic limit on <p><b>a</p>", () => {
    // 已知边界（不是回归、不判 P0）：token 级栈看不到 adoption agency 的"重建格式化元素"，
    // 因此 <p><b>a</p> 里 b 其实由 EOF 收尾，这里仍按"被 </p> 强行闭合"报。
    // 若将来改成树级比对，本断言会红并提示改写——这正是它的用途。
    expect(codesFor("<p><b>a</p>")).toEqual(["misnested_tag"]);
  });
});
