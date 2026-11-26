// 这层管：parent-death 看门狗与 `--exit-with-parent` 的接线——纯判定 `parentGone` /
// `orphanedAtLaunch`、采集口径 `parentWatchOf`、开关 `shouldWatchParent`、定时器接线 `watchParent`，
// 以及旗标从 argv 一路接到看门狗的那一段。真进程案（kill -9 假父进程 → daemon 自杀 + 端口释放）
// 在 `scripts/gui/parent-death.sh`。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARENT_POLL_MS, orphanedAtLaunch, parentGone, parentWatchOf } from "../src/parent-guard";
import { serveCommand, shouldWatchParent, watchParent } from "../src/commands/serve";
import {
  pollTimerOf,
  pollTimers,
  serveDirs,
  serveInputOf,
  startWatched,
  stopHandle,
  timerStillHoldsProcess,
  waitGone,
} from "./serve-helpers";
import { run } from "../src/run";

afterEach(() => {
  vi.restoreAllMocks();
});

const watchOf = (parentPid: number, readParentPid: () => number) => ({ parentPid, readParentPid });

describe("parentGone", () => {
  it("should stay alive while the parent pid is unchanged", () => {
    expect(parentGone(watchOf(4321, () => 4321))).toBe(false);
  });

  it("should notice a ppid of 1 as a re-parent", () => {
    expect(parentGone(watchOf(4321, () => 1))).toBe(true);
  });

  it("should notice any other ppid change", () => {
    expect(parentGone(watchOf(4321, () => 999))).toBe(true);
  });
});

describe("orphanedAtLaunch", () => {
  it("should call a ppid of 1 an orphan, not a normal parent", () => {
    expect(orphanedAtLaunch(1)).toBe(true);
    expect(orphanedAtLaunch(4321)).toBe(false);
  });
});

describe("parentWatchOf", () => {
  it("should carry the injected pid and re-read the live ppid on every poll", () => {
    const watch = parentWatchOf(4321);
    expect(watch.parentPid).toBe(4321);
    expect(watch.readParentPid()).toBe(process.ppid);
  });
});

describe("shouldWatchParent", () => {
  it("should only be true for an explicit --exit-with-parent", () => {
    expect(shouldWatchParent(undefined)).toBe(false);
    expect(shouldWatchParent(false)).toBe(false);
    expect(shouldWatchParent(true)).toBe(true);
  });
});

describe("serveCommand · 父进程看门狗的开关", () => {
  it("should not install a poll timer without --exit-with-parent", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const printed = await serveCommand(serveInputOf(dir, true, handle.stopped));
      expect(pollTimers(spy)).toBe(0);
      expect(printed).toContain('"ok":true');
    } finally {
      handle.stop();
      dir.drop();
    }
  });

  it("should install the poll timer once --exit-with-parent is on", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    try {
      const { setSpy } = await startWatched(dir, handle.stopped);
      expect(pollTimers(setSpy)).toBe(1);
    } finally {
      handle.stop();
      dir.drop();
    }
  }, 20_000);
});

describe("serveCommand · stop 撤回看门狗", () => {
  it("should drop the poll timer on stop, not just close the server", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    try {
      const { clearSpy, timer } = await startWatched(dir, handle.stopped);
      // 只 `close()` 不撤看门狗 = `--exit-with-parent` 收到 SIGTERM 后靠 1s 定时器续命。
      handle.stop();
      await vi.waitFor(() => {
        expect(clearSpy.mock.calls.some((call) => call[0] === timer)).toBe(true);
      });
    } finally {
      handle.stop();
      dir.drop();
    }
  }, 20_000);
});

describe("serveCommand · 启动时父进程已死", () => {
  it("should refuse to start when the parent was already gone at launch", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    try {
      await expect(
        serveCommand({
          ...serveInputOf(dir, true, handle.stopped),
          exitWithParent: true,
          launchParentPid: 1,
        }),
      ).rejects.toThrow(/ppid=1/);
      // 不建服务就退：home 里不该留下任何 daemon 记录。
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      handle.stop();
      dir.drop();
    }
  });

  it("should still start with a dead-looking parent when the flag is off", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    try {
      const printed = await serveCommand({
        ...serveInputOf(dir, true, handle.stopped),
        launchParentPid: 1,
      });
      expect(printed).toContain('"ok":true');
    } finally {
      handle.stop();
      dir.drop();
    }
  });
});

/** 用假时钟跑一段：区间回调不真等 1 秒。 */
const withFakeTimers = (body: () => void): void => {
  vi.useFakeTimers();
  try {
    body();
  } finally {
    vi.useRealTimers();
  }
};

describe("watchParent · 不看父进程", () => {
  it("should not schedule anything when the flag is off", () => {
    withFakeTimers(() => {
      const close = vi.fn(() => Promise.resolve());
      watchParent(undefined, { close });
      vi.advanceTimersByTime(PARENT_POLL_MS * 3);
      expect(close).not.toHaveBeenCalled();
    });
  });

  it("should keep the daemon up while the parent is alive", () => {
    withFakeTimers(() => {
      const close = vi.fn(() => Promise.resolve());
      watchParent(
        watchOf(4321, () => 4321),
        { close },
      );
      vi.advanceTimersByTime(PARENT_POLL_MS * 3);
      expect(close).not.toHaveBeenCalled();
    });
  });
});

describe("watchParent · 父进程消失", () => {
  it("should re-read the parent pid on every poll and close on the third one", () => {
    withFakeTimers(() => {
      const close = vi.fn(() => Promise.resolve());
      // 前两次还是老 ppid、第三次才变：缓存的实现会在第二次就写成“没变”，第三次看不出翻转。
      const readParentPid = vi.fn(() => 999);
      readParentPid.mockReturnValueOnce(4321).mockReturnValueOnce(4321);
      watchParent(watchOf(4321, readParentPid), { close });

      vi.advanceTimersByTime(PARENT_POLL_MS * 2);
      expect(readParentPid).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();

      vi.advanceTimersByTime(PARENT_POLL_MS);
      expect(readParentPid).toHaveBeenCalledTimes(3);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("should close once the parent disappears, and stop polling after that", () => {
    withFakeTimers(() => {
      const close = vi.fn(() => Promise.resolve());
      let ppid = 4321;
      watchParent(
        watchOf(4321, () => ppid),
        { close },
      );
      ppid = 1;
      vi.advanceTimersByTime(PARENT_POLL_MS);
      expect(close).toHaveBeenCalledTimes(1);
      // 定时器必须清掉：否则事件循环永不排空，daemon 关完服务还赖着不退。
      vi.advanceTimersByTime(PARENT_POLL_MS * 3);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});

describe("watchParent · disposer", () => {
  it("should leave no timer behind once the caller disposes it", () => {
    withFakeTimers(() => {
      const dispose = watchParent(
        watchOf(4321, () => 4321),
        {
          close: vi.fn(() => Promise.resolve()),
        },
      );
      expect(vi.getTimerCount()).toBe(1);

      dispose();

      // 定时器还在 = `close()` 之后事件循环仍有活干，进程不会自己退。
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("should unref the poll timer so it can never be what holds the daemon alive", () => {
    // 真定时器：fake timers 下 `unref()` 是空操作，删掉 `serve.ts` 那一行也没人红。
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const dispose = watchParent(
      watchOf(4321, () => 4321),
      {
        close: vi.fn(() => Promise.resolve()),
      },
    );

    expect(timerStillHoldsProcess(pollTimerOf(setSpy))).toBe(false);
    dispose();
  });

  it("should hand back a no-op when the flag is off", () => {
    withFakeTimers(() => {
      watchParent(undefined, { close: vi.fn(() => Promise.resolve()) })();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("serveCommand · --exit-with-parent 不打断正常生命周期", () => {
  it("should keep the watchdog and the daemon record across three live-parent polls", async () => {
    const dir = serveDirs();
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
    const dir = serveDirs();
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
    const dir = serveDirs();
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
      await waitGone(join(dir.home, ".hreader", "daemon.json"));

      expect(code).toBe(0);
      expect(out.join("")).toContain('"port":');
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      process.env["HOME"] = previous;
      dir.drop();
    }
  });
});
