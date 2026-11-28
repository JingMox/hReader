// This layer: per-worker HOME isolation for every vitest run — wired through `setupFiles`
// in vitest.config.ts and vitest.integration.config.ts, so it evaluates in each worker
// before any test file's modules load. Any code path that ignores `--home` /
// `HREADER_HOME` (a Stryker mutant, or a bug) then falls back to `os.homedir()` and lands
// inside this per-process temp dir instead of the real `~/.hreader` (issue #58).
//
// One home per worker process: setupFiles re-evaluate this module before every test file
// but process.env persists across a worker's files, so the marker pair carries "this
// process's home" between evaluations. Children inherit the marker too — the pid check
// keeps a spawned process (or a second worker) on its own mkdtemp home instead of
// borrowing the parent's. A test file that clobbered HOME gets it re-pointed at the
// worker's own home on the next file's setup pass.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARKER = "HREADER_TEST_HOME";
const MARKER_PID = "HREADER_TEST_HOME_PID";
const DIR_PREFIX = "hreader-test-home-";

/** The HOME family → `home` itself; XDG roots → subdirectories, so a tool consulting either convention stays inside the sandbox. */
const pointAt = (home: string): void => {
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  process.env["HREADER_HOME"] = home;
  process.env["XDG_CONFIG_HOME"] = join(home, ".config");
  process.env["XDG_DATA_HOME"] = join(home, ".local", "share");
  process.env["XDG_CACHE_HOME"] = join(home, ".cache");
};

const existing = process.env[MARKER];
if (
  existing !== undefined &&
  existing !== "" &&
  process.env[MARKER_PID] === String(process.pid) &&
  existsSync(existing)
) {
  // Same worker, later test file: HOME may have been clobbered by a sloppy test — re-point it.
  pointAt(existing);
} else {
  const home = mkdtempSync(join(tmpdir(), DIR_PREFIX));
  pointAt(home);
  process.env[MARKER] = home;
  process.env[MARKER_PID] = String(process.pid);
  // Best effort on every exit path; a leftover just sits in tmpdir until the OS sweeps it.
  process.once("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // The dir is already gone or the fs is tearing down: nothing more to do.
    }
  });
}
