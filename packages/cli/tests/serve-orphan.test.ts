// This layer: leak regression — a serve daemon started through serve-harness
// must reap itself once the process that launched it is gone.
// Repro chain: test process → killable launcher (stands in for the vitest
// worker) → `hr serve`; SIGKILLing the launcher is exactly a worker being
// killed / crashing / an interrupted run. Real conditions are polled
// (daemon.json + pidAlive); no timing guesses.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOC = '<article data-hr-id="hr-a"><p>x</p></article>';

const LAUNCH_TIMEOUT_MS = 20_000;
const REAP_TIMEOUT_MS = 15_000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const daemonPidOf = (home: string): number => {
  const file = join(home, ".hreader", "daemon.json");
  if (!existsSync(file)) return -1;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const pid: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "pid") : undefined;
  return typeof pid === "number" ? pid : -1;
};

describe("serve-harness orphan reaping", () => {
  it("should reap a harness-started serve daemon when its launcher is killed", async () => {
    const root = mkdtempSync(join(tmpdir(), "hr-serve-orphan-"));
    const ws = join(root, "ws");
    const home = join(root, "home");
    mkdirSync(ws);
    mkdirSync(home);
    writeFileSync(join(ws, "doc.html"), DOC, "utf8");
    const launcherCode = [
      `import(${JSON.stringify(new URL("./serve-harness.ts", import.meta.url).href)})`,
      `  .then((m) => m.startServe("doc.html", { json: true, home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(ws)} }))`,
      `  .then(() => { console.log("LAUNCHED"); setInterval(() => undefined, 10000); })`,
      `  .catch((error) => { console.error(String(error)); process.exitCode = 3; });`,
    ].join("\n");
    const launcher = spawn(
      process.execPath,
      ["--experimental-strip-types", "-e", launcherCode],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let launcherOut = "";
    launcher.stdout.on("data", (chunk: Buffer) => {
      launcherOut += chunk.toString("utf8");
    });
    launcher.stderr.on("data", (chunk: Buffer) => {
      launcherOut += chunk.toString("utf8");
    });
    let daemonPid = -1;
    try {
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      while (!launcherOut.includes("LAUNCHED") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(launcherOut).toContain("LAUNCHED");
      daemonPid = daemonPidOf(home);
      expect(daemonPid).toBeGreaterThan(0);
      expect(pidAlive(daemonPid)).toBe(true);

      // The worker-SIGKILL scenario: the launcher gets zero chance to run any
      // finally, so only the daemon's own watchdog can save the machine.
      launcher.kill("SIGKILL");
      await new Promise((resolve) => {
        launcher.once("exit", resolve);
      });

      const reapDeadline = Date.now() + REAP_TIMEOUT_MS;
      while (pidAlive(daemonPid) && Date.now() < reapDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(pidAlive(daemonPid)).toBe(false);
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
      // Even on a red assertion the daemon must be collected: a failed test is
      // no excuse to leave a real orphan on the machine.
      if (daemonPid > 0 && pidAlive(daemonPid)) process.kill(daemonPid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
