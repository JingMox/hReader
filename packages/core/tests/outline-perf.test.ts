// 这层管：`hr_outline` 的性能与规模（“1MB ≤150ms / 10k 节点”）以及确定性。

import { describe, expect, it } from "vitest";

import { buildOutline, parseHtml } from "../src/index";
import type { Outline } from "../src/index";

const REPEAT = 6;
const PARAGRAPH = "<p>这是一段用于测量体积的正文，包含中文与 English words 混排。</p>";

const sectionOf = (index: number): string =>
  `<section data-hr-id="sec-${String(index)}"><h2 data-hr-id="h-${String(index)}">第 ${String(index)} 节</h2>` +
  `${PARAGRAPH.repeat(REPEAT)}</section>`;

const documentOf = (sections: number): string =>
  `<article data-hr-id="doc">${Array.from({ length: sections }, (_unused, index) => sectionOf(index)).join("")}</article>`;

const flatHeadingsOf = (count: number): string =>
  `<article data-hr-id="doc">${Array.from(
    { length: count },
    (_unused, index) => `<h2 data-hr-id="h-${String(index)}">标题 ${String(index)}</h2>`,
  ).join("")}</article>`;

const nestedOf = (depth: number): string =>
  `<article data-hr-id="doc">${"<div>".repeat(depth)}<h2 data-hr-id="deep">深</h2>${"</div>".repeat(depth)}</article>`;

const outlineOf = (html: string): Outline => buildOutline(parseHtml(html));

const RUNS = 5;

/** 本进程 CPU 毫秒（user+system）：墙钟会把被抢占的时间算进来，CPU 时间只算自己烧的——
 *  满核加压时性能门不变红，GC/真开销照样计入。 */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

/** 先预热一次再取 5 次最小值：min 抹掉 GC 与同 worker 邻居用例带来的抖动。 */
const measure = (html: string): number => {
  outlineOf(html);
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < RUNS; run += 1) {
    const started = cpuMs();
    outlineOf(html);
    best = Math.min(best, cpuMs() - started);
  }
  return Math.max(best, 0.01);
};

describe("hr_outline · 规模与确定性", () => {
  it("should be byte-identical across two calls (deterministic JSON)", () => {
    const html = documentOf(80);
    const first = JSON.stringify(outlineOf(html));
    const second = JSON.stringify(outlineOf(html));

    expect(second).toBe(first);
    expect(second.length).toBeGreaterThan(100);
  });

  // 10k 节点必然超 8192B 预算，所以 `nodes` 会被截断到 ~92 个 —— 断言“不崩 + 恰好一条 truncation 诊断”，
  // 而不是“全部保留”（后者与体积上限自相矛盾）。
  it("should truncate 10k flat headings to the byte budget with exactly one diagnostic", () => {
    const outline = outlineOf(flatHeadingsOf(10_000));

    expect(outline.nodes.length).toBeGreaterThan(50);
    expect(outline.nodes.length).toBeLessThan(10_000);
    expect(outline.diagnostics.filter((item) => item.code === "outline_truncated").length).toBe(1);
    expect(JSON.stringify(outline).length).toBeLessThanOrEqual(8192);
  }, 120_000);

  it("should keep the outline of a 10k-deep document without overflowing", () => {
    const outline = outlineOf(nestedOf(10_000));

    expect(outline.nodes.map((node) => node.id)).toEqual(["deep"]);
  }, 120_000);
});

describe("hr_outline · 1MB 性能门", () => {
  it("should outline a 1MB document within budget (calibrated to the same process)", () => {
    const big = documentOf(3_000);
    const small = documentOf(300);
    expect(big.length).toBeGreaterThanOrEqual(1_000_000);

    // 交错取样：每轮先测 1/10 参考、紧接着测 1MB，两端在相邻时间窗吃同一份 CPU 争用，
    // 所以 `big/small` 比值抗噪。量的是本进程 CPU 时间（见 `cpuMs`），但满核争用下大文档的
    // 工作集被反复挤出缓存，CPU 成本本身也会涨——线性 ≈10，实测加压可上 15：界限给 20，
    // 绝对门靠 150ms 下限（空机）与 1500ms 上限（兜底）守。
    measure(big);
    measure(small);
    let bigMs = Number.POSITIVE_INFINITY;
    let smallMs = Number.POSITIVE_INFINITY;
    let ratio = Number.POSITIVE_INFINITY;
    for (let window = 0; window < 5; window += 1) {
      const reference = measure(small);
      const cost = measure(big);
      smallMs = Math.min(smallMs, reference);
      bigMs = Math.min(bigMs, cost);
      ratio = Math.min(ratio, cost / reference);
    }
    const budget = Math.max(150, smallMs * 20);

    expect(smallMs).toBeGreaterThan(0);
    expect(bigMs).toBeLessThan(budget);
    expect(ratio, `best big/small ratio ${ratio.toFixed(1)}`).toBeLessThan(20);
    expect(bigMs).toBeLessThan(1_500);
  }, 120_000);
});
