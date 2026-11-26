// This layer: the leak-gate's own contract tests — marker attribution, live/dead
// verdicts, stale-run sweeping. Real children are spawned inside per-test tmpdirs
// and always killed in finally; no assertions depend on timing.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectLeaks,
  DIR_PREFIX,
  markerOf,
  pidAlive,
  registerChild,
  RUN_ENV,
  sweepStaleRunDirs,
} from "./registry.ts";

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hr-lg-test-"));
  roots.push(dir);
  return dir;
};

/** A child that stays alive until killed; its argv carries a tmpdir marker arg. */
const spawnIdle = (markerArg: string): ReturnType<typeof spawn> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000)", markerArg], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
};

const killAll = (child: ReturnType<typeof spawn>): void => {
  if (child.pid !== undefined && pidAlive(child.pid)) child.kill("SIGKILL");
};

afterEach(() => {
  for (const child of children.splice(0)) killAll(child);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.env[RUN_ENV] = "";
});

describe("markerOf", () => {
  it("should prefer the last argv element inside tmpdir when args contain sandbox paths", () => {
    const sandboxPath = join(tmpdir(), "hr-it-x-abc", "ws");
    expect(markerOf("/usr/bin/node", ["serve", "--workspace", sandboxPath])).toBe(sandboxPath);
  });

  it("should fall back to the spawnfile when no arg touches tmpdir", () => {
    expect(markerOf("/repo/packages/cli/dist/cli.mjs", ["serve", "doc.html"])).toBe(
      "/repo/packages/cli/dist/cli.mjs",
    );
  });
});

describe("collectLeaks", () => {
  it("should flag a registered child that is still alive with its marker visible", () => {
    const dir = tempRoot();
    process.env[RUN_ENV] = dir;
    const markerArg = join(tempRoot(), "sandbox-arg");
    const child = spawnIdle(markerArg);
    registerChild(child, { tag: "idle" });

    const leaks = collectLeaks(dir);
    expect(leaks.map((leak) => leak.pid)).toContain(child.pid);
  });

  it("should not flag a registered child once it has exited", async () => {
    const dir = tempRoot();
    process.env[RUN_ENV] = dir;
    const child = spawnIdle(join(tempRoot(), "sandbox-arg"));
    registerChild(child, { tag: "idle" });
    killAll(child);
    await new Promise((resolve) => {
      child.once("exit", resolve);
    });

    expect(collectLeaks(dir).map((leak) => leak.pid)).not.toContain(child.pid);
  });

  it("should ignore a pid whose cmdline no longer carries the marker", () => {
    const dir = tempRoot();
    process.env[RUN_ENV] = dir;
    // Hand-write a record pointing at a live process that never carried our marker.
    const foreign = spawnIdle(join(tempRoot(), "unrelated-arg"));
    writeFileSync(
      join(dir, "procs-1.jsonl"),
      `${JSON.stringify({ pid: foreign.pid, group: false, marker: join(tempRoot(), "never-in-cmdline"), tag: "x" })}\n`,
      "utf8",
    );

    expect(collectLeaks(dir).map((leak) => leak.pid)).not.toContain(foreign.pid);
  });
});

describe("sweepStaleRunDirs", () => {
  it("should kill registered survivors of a dead-owner run dir and remove it", async () => {
    const ownDir = tempRoot();
    // A dir named after an owner pid that is already dead.
    const deadOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    children.push(deadOwner);
    await new Promise((resolve) => {
      deadOwner.once("exit", resolve);
    });
    const ownerPid = deadOwner.pid ?? -1;
    expect(ownerPid).toBeGreaterThan(0);
    expect(pidAlive(ownerPid)).toBe(false);

    const stale = join(tmpdir(), `${DIR_PREFIX}${String(ownerPid)}-deadbeef`);
    mkdirSync(stale, { recursive: true });
    roots.push(stale);
    const markerArg = join(tempRoot(), "stale-sandbox");
    const orphan = spawnIdle(markerArg);
    writeFileSync(
      join(stale, "procs-1.jsonl"),
      `${JSON.stringify({ pid: orphan.pid, group: false, marker: markerArg, tag: "orphan" })}\n`,
      "utf8",
    );

    const swept = sweepStaleRunDirs(ownDir);
    expect(swept).toContain(stale);
    await new Promise((resolve) => {
      orphan.once("exit", resolve);
    });
    expect(pidAlive(orphan.pid ?? -1)).toBe(false);
  });

  it("should never touch a run dir whose owner is still alive", () => {
    const ownDir = tempRoot();
    const liveOwner = spawnIdle(join(tempRoot(), "x"));
    const dir = join(tmpdir(), `${DIR_PREFIX}${String(liveOwner.pid ?? -1)}-cafef00d`);
    mkdirSync(dir, { recursive: true });
    roots.push(dir);

    expect(sweepStaleRunDirs(ownDir)).not.toContain(dir);
    expect(pidAlive(liveOwner.pid ?? -1)).toBe(true);
  });
});
