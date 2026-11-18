// 这层管：`--exit-with-parent` 从 CLI 旗标一路接到 parent-death 看门狗的那一段。
// 纯判定（ppid 变了就关）、定时器接线与 disposer 在 `units-parent-guard.test.ts`；
// "kill -9 假父进程后 daemon 自己退出、端口释放"的真进程案在 `.workflow/reports/impl-M4.2.md`。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/run";
import { serveDirs as dirs, settle, startWatched, stopHandle } from "./serve-helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serveCommand · --exit-with-parent 不打断正常生命周期", () => {
  it("should keep the watchdog and the daemon record across three live-parent polls", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      const { clearSpy, poll, timer } = await startWatched(dir, stopped);
      expect(timer).toBeDefined();
      expect(poll).toBeDefined();

      // 父进程没换：三次轮询都不该关服务，也不该把看门狗清掉。
      for (let index = 0; index < 3; index += 1) poll?.();

      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(true);
      expect(clearSpy.mock.calls.some((call) => call[0] === timer)).toBe(false);
      stop();
    } finally {
      dir.drop();
    }
  }, 20_000);

  it("should clean up on stop exactly like the default path", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      const { clearSpy, timer } = await startWatched(dir, stopped);

      stop();
      await vi.waitFor(() => {
        expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
      });
      expect(clearSpy.mock.calls.some((call) => call[0] === timer)).toBe(true);
    } finally {
      dir.drop();
    }
  });
});

describe("run · --exit-with-parent 从 argv 到看门狗", () => {
  it("should plumb the flag from argv through run() into the watchdog", async () => {
    const dir = dirs();
    const previous = process.env["HOME"];
    process.env["HOME"] = dir.home;
    const { stop, stopped } = stopHandle();
    const out: string[] = [];
    try {
      const code = await run(
        ["serve", join(dir.workspace, "doc.html"), "--port", "0", "--json", "--exit-with-parent"],
        {
          cwd: dir.workspace,
          stdout: (text) => out.push(text),
          stderr: () => undefined,
          readStdin: () => Promise.resolve(new Uint8Array()),
          debug: false,
          launchParentPid: process.ppid,
          stop: stopped,
        },
      );
      stop();
      await settle();

      expect(code).toBe(0);
      expect(out.join("")).toContain('"port":');
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      process.env["HOME"] = previous;
      dir.drop();
    }
  });
});
