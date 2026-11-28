// Absolute CPU-time budget for `listBlocks` + `resolveAddress` on a ~10 MB
// document, plus the structural 10 MB checks. Both live here and only here:
// coverage instrumentation would false-red the budget, and per-test timeouts
// do not belong in the unit suite (see vitest.perf.config.ts).

import { describe, expect, it } from "vitest";

import { listBlocks, resolveAddress } from "@hreader/core";

const BUDGET_MS = 15_000;
const TIMEOUT_MS = 120_000;

/** Milliseconds of CPU time burned by this process (user+system). Unlike wall
 * time it is not inflated by scheduling stalls, so a bound on it holds under
 * CPU contention; same-machine slowness is absorbed by the same-pipeline
 * reference below (same convention as html.perf.test.ts). */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

const section =
  "<section><h2>标题标题标题标题</h2><p>" +
  "正文正文正文正文正文正文正文正文正文正文正文正文".repeat(8) +
  "</p><p>tail tail tail tail</p></section>";

// SELECTOR_LIMITS.nth caps :nth-of-type at 9999, so one parent can't hold ≥10⁴
// same-tag siblings — group sections under wrapper divs (200 each) instead.
const buildDocument = (bytes: number): string => {
  const group = `<div>${section.repeat(200)}</div>`;
  const repeat = Math.ceil(bytes / group.length);
  return `<!DOCTYPE html><html><body><article>${group.repeat(repeat)}</article></body></html>`;
};

/** One full address pipeline pass: list every leaf block, then resolve the last one's address. */
const measure = (html: string): number => {
  const started = cpuMs();
  const blocks = listBlocks(html);
  const last = blocks[blocks.length - 1];
  if (last !== undefined) {
    resolveAddress(html, last.address);
  }
  return cpuMs() - started;
};

describe("block addresses · 10 MB document", () => {
  it(
    "should list and resolve every block on a 10 MB document",
    () => {
      const html = buildDocument(10 * 1024 * 1024);
      expect(html.length).toBeGreaterThanOrEqual(10 * 1024 * 1024);
      const blocks = listBlocks(html);
      expect(blocks.length).toBeGreaterThan(100);
      const last = blocks[blocks.length - 1];
      expect(last).toBeDefined();
      if (last === undefined) return;
      expect(resolveAddress(html, last.address)).toEqual({ ok: true, block: last });
    },
    TIMEOUT_MS,
  );

  it(
    "should list and resolve on a 10 MB document in bounded CPU time",
    () => {
      const referenceHtml = buildDocument(1024 * 1024);
      const html = buildDocument(10 * 1024 * 1024);
      expect(html.length).toBeGreaterThanOrEqual(10 * 1024 * 1024);

      // Interleaved sampling: each round measures the 1/10 reference right before
      // the 10 MB document, so both ends see the same CPU contention (same
      // convention as model.perf.test.ts).
      measure(referenceHtml);
      measure(html);
      let bestBig = Number.POSITIVE_INFINITY;
      let bestReference = Number.POSITIVE_INFINITY;
      let ratio = Number.POSITIVE_INFINITY;
      for (let window = 0; window < 3; window += 1) {
        const reference = measure(referenceHtml);
        const big = measure(html);
        bestReference = Math.min(bestReference, reference);
        bestBig = Math.min(bestBig, big);
        ratio = Math.min(ratio, big / reference);
      }

      // The pipeline is O(n): a linear 10 MB pass costs ~10x the 1 MB reference.
      // 24x leaves headroom for hardware variance; a superlinear regression
      // exceeds it by far more.
      const budget = Math.max(BUDGET_MS, bestReference * 24);
      expect(
        bestBig,
        `${String(html.length)} chars took ${bestBig.toFixed(1)}ms cpu (reference ${bestReference.toFixed(1)}ms, budget ${budget.toFixed(0)}ms)`,
      ).toBeLessThan(budget);
      expect(ratio, `best big/reference ratio ${ratio.toFixed(1)}`).toBeLessThan(30);
    },
    TIMEOUT_MS,
  );
});
