// This layer: leak regression — a serve daemon started through the integration
// harness must reap itself once the process that launched it is gone.
// Repro chain: test process → killable launcher (stands in for the vitest
// worker) → `hr serve`; SIGKILLing the launcher is exactly a worker being
// killed / crashing / an interrupted run. Real conditions are polled via
// `until`; no timing guesses.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseJson } from "../harness/check.ts";
import { until } from "../harness/env.ts";
import { pidAlive } from "../harness/proc.ts";

const DOC = '<!doctype html><html><body><article data-hr-id="a"><p>x</p></article></body></html>';

/** Ceiling for the launcher to print `LAUNCHED:<pid>` (dist serve starts sub-second; 20s is just a bound). */
const LAUNCH_TIMEOUT_MS = 20_000;
/** The watchdog polls once per second: SIGKILL → daemon suicide should land far below this. */
const REAP_TIMEOUT_MS = 15_000;

const daemonPidOf = (home: string): number => {
  const file = join(home, ".hreader", "daemon.json");
  if (!existsSync(file)) return -1;
  const parsed = parseJson(readFileSync(file, "utf8"), "daemon.json");
  const pid: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "pid") : undefined;
  return typeof pid === "number" ? pid : -1;
};

/** Spawn the in-between launcher: it imports the real harness startServe and then idles — like a busy worker. */
const launchServe = (
  workspace: string,
  home: string,
): ChildProcessByStdio<null, Readable, Readable> => {
  const launcherCode = [
    `import(${JSON.stringify(new URL("../harness/serve.ts", import.meta.url).href)})`,
    `  .then((m) => m.startServe({ file: "doc.html", workspace: ${JSON.stringify(workspace)}, home: ${JSON.stringify(home)} }))`,
    `  .then((d) => { console.log("LAUNCHED:" + String(d.pid)); setInterval(() => undefined, 10000); })`,
    `  .catch((error) => { console.error(String(error)); process.exitCode = 3; });`,
  ].join("\n");
  return spawn(process.execPath, ["--experimental-strip-types", "-e", launcherCode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
};

describe("daemon orphan reaping", () => {
  it("should reap a harness-started serve daemon when its launcher is killed", async () => {
    const root = mkdtempSync(join(tmpdir(), "hr-orphan-"));
    const ws = join(root, "ws");
    const home = join(root, "home");
    mkdirSync(ws);
    mkdirSync(home);
    writeFileSync(join(ws, "doc.html"), DOC, "utf8");
    let daemonPid = -1;
    const launcher = launchServe(ws, home);
    let launcherOut = "";
    launcher.stdout.on("data", (chunk: Buffer) => {
      launcherOut += chunk.toString("utf8");
    });
    launcher.stderr.on("data", (chunk: Buffer) => {
      launcherOut += chunk.toString("utf8");
    });
    try {
      const launched = await until(
        () => /LAUNCHED:(\d+)/u.exec(launcherOut)?.[1],
        (value) => value !== undefined,
        { timeoutMs: LAUNCH_TIMEOUT_MS },
      );
      expect(launched).toBeDefined();
      daemonPid = Number(launched);
      expect(pidAlive(daemonPid)).toBe(true);
      expect(daemonPidOf(home)).toBe(daemonPid);

      // The worker-SIGKILL scenario: the launcher gets zero chance to run any
      // finally, so only the daemon's own watchdog can save the machine.
      launcher.kill("SIGKILL");
      await new Promise((resolve) => {
        launcher.once("exit", resolve);
      });

      const reaped = await until(() => !pidAlive(daemonPid), (gone) => gone, {
        timeoutMs: REAP_TIMEOUT_MS,
      });
      expect(reaped).toBe(true);
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
      // Even on a red assertion the daemon must be collected: a failed test is
      // no excuse to leave a real orphan on the machine.
      if (daemonPid > 0 && pidAlive(daemonPid)) process.kill(daemonPid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
