// This layer: deciding whether a daemon should kill itself when the parent disappears, plus how the pid is captured; reads nothing beyond process, starts no timers.
//
// When the shell is `kill -9`'d the Rust side gets no chance to clean up (`Daemon`'s Drop never runs), so `hr serve` must watch the parent itself.
// Only enabled when the shell explicitly passes `--exit-with-parent`: a user-started daemon must not die just because its terminal exited.

/** The parent pid recorded at startup plus the injection point for reading the live ppid (the real one reads `process.ppid`). */
export interface ParentWatch {
  readonly parentPid: number;
  readonly readParentPid: () => number;
}

/** Checked once a second: the parent being swapped out (re-parented to 1 or another pid) = the shell is gone. */
export const PARENT_POLL_MS = 1_000;

/**
 * The parent is already init at startup: the shell died after spawn, before we got here.
 * Watching the parent from this state detects nothing — `process.ppid` is already 1 and would be recorded as a "normal parent pid".
 */
export const orphanedAtLaunch = (parentPid: number): boolean => parentPid === 1;

export const parentGone = (watch: ParentWatch): boolean =>
  watch.readParentPid() !== watch.parentPid;

/** `parentPid` must be the value the shell captured early in startup (before any `await`); see `main.ts`. */
export const parentWatchOf = (parentPid: number): ParentWatch => ({
  parentPid,
  readParentPid: () => process.ppid,
});
