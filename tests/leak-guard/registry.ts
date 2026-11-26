// This layer: shared registration and exit-time reaping for test-spawned processes —
// the process that spawns a child also records it, and globalSetup's teardown delivers
// the final verdict across processes. Each registration appends one JSON line to
// `$TMPDIR/hr-leakguard-<setupPid>-<rand>/procs-<ownerPid>.jsonl`. The run dir travels
// through the HR_LEAKGUARD_RUN env var: globalSetup → vitest workers → spawned
// grandchildren, so daemons and Chromes can be attributed to this run even after the
// worker that started them is dead.
//
// Only test-spawned processes get registered; the marker (the argv element containing
// tmpdir, or the entry file path) keeps recycled pids and other agents' processes out —
// a leak verdict requires "pid alive AND cmdline still contains the marker".

import { execFileSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const RUN_ENV = "HR_LEAKGUARD_RUN";
export const DIR_PREFIX = "hr-leakguard-";

interface ProcRecord {
  readonly pid: number;
  /** true = spawned detached, so pid is the process-group leader and `-pid` takes the whole group. */
  readonly group: boolean;
  /** Attribution string: an argv element containing tmpdir (unique per test sandbox), or the entry file path. */
  readonly marker: string;
  readonly tag: string;
}

export interface LeakedProc extends ProcRecord {
  readonly cmdline: string;
}

/** Run dir: created by globalSetup and inherited via env; bare runs (no globalSetup) mint their own on first registration. */
export const ensureRunDir = (): string => {
  const existing = process.env[RUN_ENV];
  if (existing !== undefined && existing !== "") {
    mkdirSync(existing, { recursive: true });
    return existing;
  }
  const dir = join(
    tmpdir(),
    `${DIR_PREFIX}${String(process.pid)}-${randomBytes(4).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  process.env[RUN_ENV] = dir;
  return dir;
};

const tempDirCandidates = (): readonly string[] => {
  const base = tmpdir();
  try {
    const real = realpathSync(base);
    return real === base ? [base] : [base, real];
  } catch {
    return [base];
  }
};

/** Attribution string: prefer the last argv element containing tmpdir (unique per test sandbox); fall back to the entry file. */
export const markerOf = (spawnfile: string, args: readonly string[]): string => {
  const dirs = tempDirCandidates();
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg !== undefined && dirs.some((dir) => arg.includes(dir))) return arg;
  }
  return spawnfile;
};

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** POSIX process-group kill: only safe for detached children (pid is the pgid); falls back to the single pid. */
export const killPid = (pid: number, group: boolean, signal: NodeJS.Signals = "SIGKILL"): void => {
  if (pid <= 0) return;
  if (group && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a group leader (not detached / group already gone): fall through to the single pid.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already dead: goal achieved.
  }
};

const own = new Map<ChildProcess, boolean>();
let sweeperArmed = false;

const sweepOwn = (): void => {
  for (const [proc, group] of own) {
    if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) continue;
    killPid(proc.pid, group, "SIGKILL");
  }
};

/**
 * Register a spawned child. `group` = the caller spawned it detached (pid is the group leader).
 * Comes with a per-process exit hook: anything still registered gets one last SIGKILL on
 * any exit path the owner process takes.
 */
export const registerChild = (
  proc: ChildProcess,
  options: { readonly group?: boolean; readonly tag?: string } = {},
): void => {
  if (proc.pid === undefined) return;
  const group = options.group === true;
  own.set(proc, group);
  proc.once("exit", () => {
    own.delete(proc);
  });
  const record: ProcRecord = {
    pid: proc.pid,
    group,
    marker: markerOf(proc.spawnfile, proc.spawnargs.slice(1)),
    tag: options.tag ?? proc.spawnfile,
  };
  try {
    appendFileSync(
      join(ensureRunDir(), `procs-${String(process.pid)}.jsonl`),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  } catch {
    // Bookkeeping failure must not fail the test: the sweep just gets weaker.
  }
  if (!sweeperArmed) {
    sweeperArmed = true;
    process.on("exit", sweepOwn);
  }
};

const cmdlineOf = (pid: number): string => {
  if (process.platform === "win32") return "";
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return "";
  }
};

const recordsIn = (dir: string): ProcRecord[] => {
  const out: ProcRecord[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.startsWith("procs-") || !name.endsWith(".jsonl")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null) {
          const rec = parsed as ProcRecord;
          if (typeof rec.pid === "number") out.push(rec);
        }
      } catch {
        // Torn or corrupt line: skip it, never abort the whole scan.
      }
    }
  }
  return out;
};

/**
 * Verdict: registered, still alive, and cmdline still carries the marker (that keeps out
 * recycled pids and other agents' processes). win32 has no cmdline, so pidAlive alone
 * decides (conservative; may false-flag a recycled pid).
 */
export const collectLeaks = (dir: string): LeakedProc[] => {
  const leaks: LeakedProc[] = [];
  if (!existsSync(dir)) return leaks;
  const seen = new Set<number>();
  for (const rec of recordsIn(dir)) {
    if (seen.has(rec.pid)) continue;
    seen.add(rec.pid);
    if (!pidAlive(rec.pid)) continue;
    const cmdline = cmdlineOf(rec.pid);
    if (cmdline !== "" && !cmdline.includes(rec.marker)) continue;
    if (cmdline === "" && process.platform !== "win32") continue;
    leaks.push({ ...rec, cmdline });
  }
  return leaks;
};

/** Shared by teardown and sweepers: kill every entry in a verdict list (group first). */
export const killLeaks = (leaks: readonly LeakedProc[]): void => {
  for (const leak of leaks) killPid(leak.pid, leak.group);
};

const ownerPidOf = (name: string): number => {
  const match = new RegExp(`^${DIR_PREFIX}(\\d+)-`, "u").exec(name);
  return match === null ? -1 : Number(match[1]);
};

/**
 * Dead dirs from earlier runs: owner pid is dead → any still-living registered process in
 * there is an orphan; kill it, then remove the dir. Dirs whose owner is still alive
 * (another agent mid-run) are never touched. Returns swept dir names (diagnostics).
 * Pid reuse degrades this to a miss, never a misfire: if the dead owner's pid got
 * recycled, pidAlive looks true and the dir is skipped — stale state lingers one
 * more run, but nothing foreign can be killed.
 */
export const sweepStaleRunDirs = (ownDir: string): string[] => {
  const swept: string[] = [];
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return swept;
  }
  for (const name of names) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    if (dir === ownDir) continue;
    const owner = ownerPidOf(name);
    if (owner === -1 || pidAlive(owner)) continue;
    killLeaks(collectLeaks(dir));
    try {
      rmSync(dir, { recursive: true, force: true });
      swept.push(dir);
    } catch {
      // Dir got reclaimed by a concurrent process: not a failure.
    }
  }
  return swept;
};

/** For globalSetup: create this run's dir; the setupPid in its name is what sweepStaleRunDirs checks. */
export const createRunDir = (): string => {
  const dir = join(
    tmpdir(),
    `${DIR_PREFIX}${String(process.pid)}-${randomBytes(4).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  process.env[RUN_ENV] = dir;
  return dir;
};
