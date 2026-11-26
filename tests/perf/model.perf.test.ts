// Absolute CPU-time budgets for `toDocumentModel` on ~1MB documents. Coverage
// instrumentation would false-red them, so they run only under `pnpm test:perf`
// (see vitest.perf.config.ts); the instrumentation-invariant growth ratios and
// the deep-nesting functional checks stay in packages/core/tests/model.test.ts.

import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml, toDocumentModel } from "@hreader/core";

const paragraph = (index: number): string =>
  `第 ${String(index)} 段：` +
  "读写分离、主从复制与脑裂取舍的工程判断，必须在具体延迟预算与一致性语义下讨论。".repeat(4);

/** Same construction as html.perf.test.ts: real long text, ~3000 sections at 1MB. */
const buildDocument = (sections: number): string => {
  const parts: string[] = ["<!DOCTYPE html><html><head><title>bench</title></head><body><article>"];
  for (let index = 0; index < sections; index += 1) {
    parts.push(
      `<section><h2>标题 ${String(index)}</h2><p>${paragraph(index)}</p><p>${paragraph(index + 1)}</p></section>`,
    );
  }
  parts.push("</article></body></html>");
  return parts.join("");
};

/** Node-dense 1MB: only for catching blow-up-scale regressions. */
const wide = (paragraphs: number): string =>
  `<article>${Array.from({ length: paragraphs }, (_, index) => `<p>第 ${String(index)} 段</p>`).join("\n")}</article>`;

/** Pipeline cost of `buildDocument(300)` on an idle machine (ms): the calibration denominator. */
const IDLE_REFERENCE_MS = 4;

/**
 * Milliseconds of CPU time burned by this process (user+system). Unlike wall
 * time it is not inflated by scheduling stalls, so a bound on it holds under
 * CPU contention; same-machine slowness is absorbed by the slowdown factor
 * and the same-run reference ratio below.
 */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

const measure = (html: string): number => {
  const started = cpuMs();
  const parsed = parseHtml(html);
  const injected = injectNodeIds(parsed);
  toDocumentModel(injected.parsed);
  return cpuMs() - started;
};

/** Take the fastest run: noise only slows a sample, so the minimum is closest to the true cost (same convention as html.perf). */
const fastest = (html: string, runs: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index += 1) {
    best = Math.min(best, measure(html));
  }
  return best;
};

describe("toDocumentModel · absolute budgets on ~1MB documents", () => {
  // Noise-resistant shape: **interleaved sampling**. Each round measures the
  // 1/10 reference immediately before the 1MB document, so both ends see the
  // same CPU contention and `big/ref` stays stable (linear ≈10). The absolute
  // gate still derives its slowdown factor from the reference cost, taking the
  // minimum over 5 rounds (contention only ever raises a sample).
  it("should keep a 1MB document under 200ms and grow linearly against a 1/10 reference", () => {
    const referenceHtml = buildDocument(300);
    const bigHtml = buildDocument(3000);

    expect(bigHtml.length).toBeGreaterThan(1_000_000);
    measure(bigHtml);
    measure(referenceHtml);
    let ratio = Number.POSITIVE_INFINITY;
    let bestBig = Number.POSITIVE_INFINITY;
    let bestReference = Number.POSITIVE_INFINITY;
    for (let window = 0; window < 5; window += 1) {
      const reference = measure(referenceHtml);
      const big = measure(bigHtml);
      bestReference = Math.min(bestReference, reference);
      bestBig = Math.min(bestBig, big);
      ratio = Math.min(ratio, big / reference);
    }
    // Without coverage instrumentation the cap only absorbs hardware variance;
    // 8x stays reasonable — a real superlinear regression exceeds it by far more.
    const slowdown = Math.min(Math.max(bestReference / IDLE_REFERENCE_MS, 1), 8);

    expect(
      bestBig,
      `${String(bigHtml.length)} chars took ${bestBig.toFixed(1)}ms cpu (reference ${bestReference.toFixed(1)}ms)`,
    ).toBeLessThan(200 * slowdown);
    // 10x the size: linear ≈10, quadratic ≈100.
    expect(ratio, `best big/reference ratio ${ratio.toFixed(1)}`).toBeLessThan(14);
  }, 120_000);

  it("should stay under a coarse ceiling on a node-dense 1MB document", () => {
    const html = wide(64_000);

    expect(html.length).toBeGreaterThan(1_000_000);
    expect(fastest(html, 2)).toBeLessThan(8_000);
  }, 30_000);
});
