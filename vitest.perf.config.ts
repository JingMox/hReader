// This layer runs the absolute-time-budget performance gates (tests/perf/**).
// Why a separate suite: v8 coverage instrumentation slows src/** several times
// over, so any "<Nms" assertion false-reds inside `pnpm test:coverage` no matter
// whether it reads wall time or CPU time. Ratios and structural bounds stay in
// the unit suite; only absolute budgets live here — no coverage, one worker,
// sequential files, so a measurement never races a sibling test for the CPU.

import { defineConfig } from "vitest/config";

import { packageAliases } from "./vitest.shared.ts";

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    include: ["tests/perf/**/*.perf.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    // The heaviest cases build ~1MB documents and measure them in repeated
    // windows; the unit-suite 30s budget would false-kill them under load.
    testTimeout: 120_000,
  },
});
