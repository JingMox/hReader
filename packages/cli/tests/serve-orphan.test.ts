// 这层管：泄漏回归——经 serve-harness 起的 daemon，在启动它的进程消失后必须自己退出。
// 复现链：测试进程 → 中间启动器（扮演 vitest worker）→ `hr serve`；SIGKILL 启动器等价于
// worker 被杀/崩溃/被打断。靠轮真条件（daemon.json + pidAlive），不猜毫秒。

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
    const launcher = spawn(process.execPath, ["--experimental-strip-types", "-e", launcherCode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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

      // worker 被 SIGKILL 的场景：launcher 没有任何机会跑 finally，daemon 只能靠看门狗自救。
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
      // 失败路径也要收掉这个 daemon：测试断言红归红，机器上不许真留孤儿。
      if (daemonPid > 0 && pidAlive(daemonPid)) process.kill(daemonPid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
