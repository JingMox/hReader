// This layer: the leak gate's globalSetup — setup creates this run's registry dir
// (HR_LEAKGUARD_RUN travels through process env into workers and grandchildren) and
// sweeps orphans left behind by previous dead runs; teardown delivers the verdict:
// any registered process still alive with its marker in the cmdline gets SIGKILLed
// and fails the whole run. Attribution only trusts "a record in the run dir + marker
// match", so other agents' same-host processes can never be flagged.

import { rmSync } from "node:fs";

import { collectLeaks, createRunDir, killLeaks, RUN_ENV, sweepStaleRunDirs } from "./registry.ts";

export const setup = (): void => {
  const dir = createRunDir();
  // Dead dirs from interrupted earlier runs: owner is gone, so any still-living
  // registered process in there is an orphan — kill it, then remove the dir.
  sweepStaleRunDirs(dir);
};

export const teardown = (): void => {
  const dir = process.env[RUN_ENV];
  if (dir === undefined || dir === "") return;
  const leaks = collectLeaks(dir);
  if (leaks.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  killLeaks(leaks);
  const detail = leaks
    .map(
      (leak) => `pid=${String(leak.pid)} marker=${leak.marker} cmd=${leak.cmdline.slice(0, 160)}`,
    )
    .join("\n  ");
  throw new Error(
    `test run ended with ${String(leaks.length)} registered test-spawned process(es) still alive (registry kept at ${dir}):\n  ${detail}`,
  );
};
