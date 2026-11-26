import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_SEVERITY, RAW_TEXT_TAGS } from "../src/html/constants";
import { stableHex8 } from "../src/html/hash";
import { injectNodeIds, parseHtml, serializeHtml } from "../src/index";
import { codesOf, findElement, messagesOf } from "./html-support";

// 这层管：html 解析/注入修复项的回归闸——每块对应一处修过的缺陷，且都是"修前必红"的形状。

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

const nestedDocument = (depth: number): string =>
  ARTICLE(`${"<div>".repeat(depth)}x${"</div>".repeat(depth)}`);
const PERF_ITERATIONS = 16;
const PERF_WINDOWS = 5;

/**
 * Milliseconds of CPU time burned by this process (user+system). Unlike wall
 * time it is not inflated by scheduling stalls, so a bound on it holds under
 * CPU contention; same-machine slowness (coverage, weak cores) lifts the
 * shallow and deep costs together, leaving the growth ratio intact.
 */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

/**
 * One "window" = 16 iterations of `injectNodeIds(parseHtml(...))` averaged;
 * the per-window average flattens 1~3ms GC jitter.
 * The key is **interleaving**: shallow/deep are measured in adjacent windows
 * and divided, so both ends share the same machine conditions — the ratio is
 * noise-resistant. Take the smallest ratio over 5 windows (interference only
 * ever raises a sample; the minimum is closest to the true ratio).
 */
const injectionWindowMs = (depth: number): number => {
  const html = nestedDocument(depth);
  const started = cpuMs();
  for (let index = 0; index < PERF_ITERATIONS; index += 1) {
    injectNodeIds(parseHtml(html));
  }
  return (cpuMs() - started) / PERF_ITERATIONS;
};

/** Interleave 5 (shallow, deep) pairs; return the smallest single-pair ratio and each depth's minimum cost. */
const growthPair = (
  shallowDepth: number,
  deepDepth: number,
): {
  readonly growth: number;
  readonly shallow: number;
  readonly deep: number;
} => {
  injectionWindowMs(shallowDepth);
  injectionWindowMs(deepDepth);
  let growth = Number.POSITIVE_INFINITY;
  let shallow = Number.POSITIVE_INFINITY;
  let deep = Number.POSITIVE_INFINITY;
  for (let window = 0; window < PERF_WINDOWS; window += 1) {
    const shallowCost = injectionWindowMs(shallowDepth);
    const deepCost = injectionWindowMs(deepDepth);
    shallow = Math.min(shallow, shallowCost);
    deep = Math.min(deep, deepCost);
    growth = Math.min(growth, deepCost / shallowCost);
  }
  return { growth, shallow, deep };
};

// 线性度判据的形态与实测依据（模块级：注释也算函数行数，放进 describe 会撞 max-lines-per-function）。
// 判据 = 深度放大 4 倍时的单次注入耗时比：线性 ≈4.0，O(n²) ≈16.0；阈值 6.0 落在两者之间。
// 为什么用 4 倍而不是翻倍：t(4000) 本身很稳（实测 3.75~4.41ms，±8%），而 t(1000)≈1ms 会被干扰
// 单向抬高（实测 0.91~1.93ms），比值因此只会**偏低**；4 倍跨度让"偏低"仍安全通过（实测 1.95~4.21 < 6），
// 而真退化成 O(n²) 时 t(4000) 会涨到 ≈16ms，比值 ≥8 必红。
// 交错窗口（见 injectionWindowMs）：同一次争用同时抬高分子分母，min-of-5 再剔掉尖峰。
// 不用 t(4000)/t(500)：分母 0.3~1.5ms，与分子不在同一时间窗，实测比值 2.7~7.3 乱跳，曾 16.35/16 假红。
describe("inject · 深嵌套耗时近似线性", () => {
  it("should grow linearly (not quadratically) with nesting depth", () => {
    const { growth, deep } = growthPair(1000, 4000);

    expect(growth, `t(4000)/t(1000) = ${growth.toFixed(2)}`).toBeLessThan(6);
    expect(deep).toBeLessThan(200);
  }, 120_000);

  it("should inject an id into every nested <div> regardless of depth", () => {
    const injected = injectNodeIds(parseHtml(nestedDocument(4000)));
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
