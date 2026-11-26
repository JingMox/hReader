// Absolute CPU-time budgets for the HTML parse+inject pipeline. Coverage
// instrumentation would false-red them, so they run only under `pnpm test:perf`
// (see vitest.perf.config.ts); the instrumentation-invariant growth ratios and
// the deep-nesting functional checks stay in packages/core/tests/html-perf.test.ts
// and html-regression.test.ts.

import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml } from "@hreader/core";

const BUDGET_MS = 300;
const TIMEOUT_MS = 120_000;

/**
 * Milliseconds of CPU time burned by this process (user+system). Unlike wall
 * time it is not inflated by scheduling stalls, so a bound on it holds under
 * CPU contention; same-machine slowness (weak cores) is absorbed by the
 * same-pipeline reference below.
 */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

const paragraph = (index: number): string =>
  `第 ${String(index)} 段：` +
  "读写分离、主从复制与脑裂取舍的工程判断，必须在具体延迟预算与一致性语义下讨论。".repeat(4);

const section = (index: number): string =>
  `<section><h2>标题 ${String(index)}</h2><p>${paragraph(index)}</p><p>${paragraph(index + 1)}</p></section>`;

const buildDocument = (sections: number): string => {
  const parts: string[] = ["<!DOCTYPE html><html><head><title>bench</title></head><body><article>"];
  for (let index = 0; index < sections; index += 1) {
    parts.push(section(index));
  }
  parts.push("</article></body></html>");
  return parts.join("");
};

/** parse + inject cost in milliseconds of this process's own CPU time. */
const measure = (html: string): number => {
  const start = cpuMs();
  injectNodeIds(parseHtml(html));
  return cpuMs() - start;
};

const fastest = (html: string, runs: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index += 1) {
    best = Math.min(best, measure(html));
  }
  return best;
};

// Self-calibration of the 300ms CPU bound: Budget = max(300ms, CPU cost of the
// same pipeline at 1/4 size * 8). A real O(n^2) regression would also trip the
// ratio gate kept in the unit suite and the 8x relation here.
const budgetFor = (html: string): { readonly cost: number; readonly budget: number } => {
  fastest(buildDocument(20), 2);
  const quarterCost = fastest(buildDocument(750), 3);
  const cost = fastest(html, 3);
  return { cost, budget: Math.max(BUDGET_MS, quarterCost * 8) };
};

describe("parse+inject · one megabyte document", () => {
  it(
    "should parse and inject a 1MB document within 300ms",
    () => {
      const html = buildDocument(3000);
      expect(html.length).toBeGreaterThan(1_000_000);

      const { cost, budget } = budgetFor(html);

      expect(html.length, `body size ${String(html.length)}`).toBeGreaterThan(1_000_000);
      expect(
        cost,
        `parse+inject of ${String(html.length)} chars took ${cost.toFixed(1)}ms cpu, budget ${budget.toFixed(0)}ms`,
      ).toBeLessThanOrEqual(budget);
    },
    TIMEOUT_MS,
  );
});

const nestedDocument = (depth: number): string =>
  `<!DOCTYPE html><html><head></head><body><article>${"<div>".repeat(depth)}x${"</div>".repeat(depth)}</article></body></html>`;
const PERF_ITERATIONS = 16;
const PERF_WINDOWS = 5;

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

describe("inject · near-linear cost across nesting depth", () => {
  it("should grow linearly (not quadratically) with nesting depth", () => {
    const { growth, deep } = growthPair(1000, 4000);

    expect(growth, `t(4000)/t(1000) = ${growth.toFixed(2)}`).toBeLessThan(6);
    expect(deep).toBeLessThan(200);
  }, 120_000);
});
