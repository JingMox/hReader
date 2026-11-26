// Absolute CPU-time budget for `hr_outline` on a ~1MB document ("1MB ≤150ms").
// Coverage instrumentation would false-red it, so it runs only under
// `pnpm test:perf` (see vitest.perf.config.ts); the scale/determinism cases and
// the instrumentation-invariant growth ratio stay in
// packages/core/tests/outline-perf.test.ts.

import { describe, expect, it } from "vitest";

import { buildOutline, parseHtml } from "@hreader/core";
import type { Outline } from "@hreader/core";

const REPEAT = 6;
const PARAGRAPH = "<p>这是一段用于测量体积的正文，包含中文与 English words 混排。</p>";

const sectionOf = (index: number): string =>
  `<section data-hr-id="sec-${String(index)}"><h2 data-hr-id="h-${String(index)}">第 ${String(index)} 节</h2>` +
  `${PARAGRAPH.repeat(REPEAT)}</section>`;

const documentOf = (sections: number): string =>
  `<article data-hr-id="doc">${Array.from({ length: sections }, (_unused, index) => sectionOf(index)).join("")}</article>`;

const outlineOf = (html: string): Outline => buildOutline(parseHtml(html));

const RUNS = 5;

/**
 * Milliseconds of CPU time burned by this process (user+system). Wall time
 * counts time stolen by preemption; CPU time only counts what this process
 * burned — the perf gate stays green under a fully loaded box while GC and
 * real cost still register.
 */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

/** Warm up once, then take the minimum of 5 runs: min cancels GC and sibling-test jitter. */
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

describe("hr_outline · 1MB performance gate", () => {
  it("should outline a 1MB document within budget (calibrated to the same process)", () => {
    const big = documentOf(3_000);
    const small = documentOf(300);
    expect(big.length).toBeGreaterThanOrEqual(1_000_000);

    // Interleaved sampling: each round measures the 1/10 reference immediately
    // before the 1MB document so both ends share the same CPU contention, and
    // `big/small` stays noise-resistant. CPU time is measured (see `cpuMs`), but
    // under a saturated box the big document's working set keeps getting evicted
    // and its CPU cost rises too — linear ≈10, stressed can reach 15: the bound
    // is 20, backed by the 150ms floor (idle machine) and the 1500ms ceiling.
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
