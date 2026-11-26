// Absolute CPU-time budget for the degraded path of `annotations/diff.ts`
// (20k inputs must short-circuit in O(n), not run the quadratic matrix).
// Coverage instrumentation would false-red it, so it runs only under
// `pnpm test:perf` (see vitest.perf.config.ts); the degradation-shape cases
// stay in packages/core/tests/annotations/diff.test.ts.

import { describe, expect, it } from "vitest";

import { diffText, DIFF_CHAR_LIMIT } from "@hreader/core";

/**
 * Milliseconds of CPU time burned by this process (user+system). Unlike wall
 * time it is not inflated by scheduling stalls, so a bound on it holds under
 * CPU contention.
 */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

describe("diffText · degraded path cost", () => {
  it("should return 20k inputs in under 200ms (degraded path is O(n))", () => {
    const before = Array.from({ length: 40 }, (_, i) => `第${String(i)}行`).join("\n");
    const padded = `${before}${"x".repeat(DIFF_CHAR_LIMIT - before.length + 1)}`;
    const after = `${padded.slice(0, -1)}y`;
    const started = cpuMs();
    const result = diffText(padded, after);
    const elapsed = cpuMs() - started;

    expect(result.degraded).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});
