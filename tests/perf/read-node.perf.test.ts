// Absolute CPU-time budgets for `readNode` on a ~1MB document. Coverage
// instrumentation would false-red them, so they run only under `pnpm test:perf`
// (see vitest.perf.config.ts); the machine-independent parts of the same
// scenarios stay in packages/core/tests/read-node.test.ts.

import { describe, expect, it } from "vitest";

import { parseHtml, readNode } from "@hreader/core";
import type { ReadNodeResult } from "@hreader/core";

const buildLarge = (sections: number): string =>
  `<article data-hr-id="post">${Array.from(
    { length: sections },
    (_, index) =>
      `<section data-hr-id="s${String(index)}"><h2>标题 ${String(index)}</h2><p>${"文".repeat(160)}</p></section>`,
  ).join("")}</article>`;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Milliseconds of CPU time burned by this process (user+system). Unlike wall
 * time it is not inflated by scheduling stalls, so a bound on it holds under
 * CPU contention; same-machine slowness (weak cores) is absorbed by the
 * slowdown factor below.
 */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

const fastest = (run: () => unknown, attempts: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < attempts; index += 1) {
    const started = cpuMs();
    run();
    best = Math.min(best, cpuMs() - started);
  }
  return best;
};

const read = (html: string, target: string, maxBytes?: number): ReadNodeResult =>
  readNode(parseHtml(html), target, maxBytes);

// The slowdown caps (20x / 8x) used to absorb coverage instrumentation as well;
// this suite runs without coverage, so they now only cover hardware variance.
// That is still the right order of magnitude: a genuine superlinear regression
// would exceed the bound by far more than the cap.
describe("readNode · one megabyte document", () => {
  it("should read a 64KB subtree out of a 1MB document within 60ms", () => {
    const big = buildLarge(5_000);
    const medium = buildLarge(500);
    const reference = fastest(() => read(medium, "#s250"), 3);
    const slowdown = Math.min(Math.max(reference / 2, 1), 20);
    const elapsed = fastest(() => read(big, "#s2500"), 3);

    expect(byteLength(big)).toBeGreaterThan(1_000_000);
    expect(
      elapsed,
      `1MB/${String(byteLength(big))}B read took ${elapsed.toFixed(1)}ms cpu (slowdown ${slowdown.toFixed(1)}x)`,
    ).toBeLessThan(60 * slowdown);
  }, 30_000);

  it("should truncate a full article read out of a 1MB document within 120ms", () => {
    const big = buildLarge(5_000);
    const medium = buildLarge(500);
    const reference = fastest(() => read(medium, "article"), 3);
    const slowdown = Math.min(Math.max(reference / 5, 1), 8);
    const elapsed = fastest(() => read(big, "article"), 3);
    const result = read(big, "article");

    expect(result.truncated).toBe(true);
    expect(byteLength(result.html)).toBeLessThanOrEqual(65_536);
    expect(
      elapsed,
      `article read took ${elapsed.toFixed(1)}ms cpu (slowdown ${slowdown.toFixed(1)}x)`,
    ).toBeLessThan(120 * slowdown);
  }, 60_000);
});
