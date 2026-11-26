// 这层管：泄漏回归——经集成 harness 起的 daemon，在启动它的进程消失后必须自己退出。
// 复现链：测试进程 → 中间启动器（扮演 vitest worker）→ `hr serve`；SIGKILL 启动器等价于
// worker 被杀/崩溃/被 Ctrl+C 打断。靠 until 轮真条件，不猜毫秒。

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

/** 启动器打出 `LAUNCHED:<pid>` 的等待上限（dist serve 启动是秒级以下，20s 只是兜底）。 */
const LAUNCH_TIMEOUT_MS = 20_000;
/** 看门狗 1s 一轮：从 SIGKILL 到 daemon 自尽应远小于此上限。 */
const REAP_TIMEOUT_MS = 15_000;

const daemonPidOf = (home: string): number => {
  const file = join(home, ".hreader", "daemon.json");
  if (!existsSync(file)) return -1;
  const parsed = parseJson(readFileSync(file, "utf8"), "daemon.json");
  const pid: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "pid") : undefined;
  return typeof pid === "number" ? pid : -1;
};

/** 起"中间启动器"：它自己 import 真 harness 的 startServe，然后装死挂住——就像一个跑中的 worker。 */
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

      // worker 被 SIGKILL 的场景：launcher 没有任何机会跑 finally，daemon 只能靠看门狗自救。
      launcher.kill("SIGKILL");
      await new Promise((resolve) => {
        launcher.once("exit", resolve);
      });

      const reaped = await until(
        () => !pidAlive(daemonPid),
        (gone) => gone,
        {
          timeoutMs: REAP_TIMEOUT_MS,
        },
      );
      expect(reaped).toBe(true);
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
      // 失败路径也要收掉这个 daemon：测试断言红归红，机器上不许真留孤儿。
      if (daemonPid > 0 && pidAlive(daemonPid)) process.kill(daemonPid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
