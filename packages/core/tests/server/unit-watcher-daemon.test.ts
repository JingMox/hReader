// 这层管：`watcher.ts`（去抖 / 回声窗口 / 去重）与 `daemon.ts`（daemon.json 的解析、原子写、只删自己的）。
//
// watcher 用注入源 + 假时钟：事件手动派发、去抖用 advanceTimersByTime 驱动，与真盘时序无关。

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import {
  daemonAlive,
  daemonFileOf,
  parseDaemon,
  portOpen,
  readDaemonOf,
  removeDaemonOf,
  writeDaemonOf,
} from "../../src/server/daemon";
import { createWatcher, DEBOUNCE_MS, type Watcher } from "../../src/server/watcher";

type OnEvent = (event: string, name: string | undefined) => void;

const DIR = "/tmp/hr-watch-fake";

interface WatchCase {
  readonly watcher: Watcher;
  readonly changes: string[];
  readonly fire: OnEvent;
}

/** 注入事件源：fire 手动派发 chokidar 归一化语义的事件，去抖定时器用 vi 推进。 */
const withWatcher = (run: (testCase: WatchCase) => void): void => {
  vi.useFakeTimers();
  const changes: string[] = [];
  let closed = false;
  let onEvent: OnEvent = () => undefined;
  const watcher = createWatcher({ onFileChange: (path) => changes.push(path) }, (_dir, emit) => {
    onEvent = emit;
    return {
      close: () => {
        closed = true;
      },
    };
  });
  try {
    run({
      watcher,
      changes,
      fire: (event, name) => {
        if (!closed) onEvent(event, name);
      },
    });
  } finally {
    watcher.close();
    vi.useRealTimers();
  }
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createWatcher · 去抖与过滤", () => {
  it("should collapse a burst of writes into one change", () => {
    withWatcher(({ watcher, changes, fire }) => {
      watcher.add(DIR, "a.html");
      for (let burst = 0; burst < 3; burst += 1) {
        fire("change", "a.html");
        vi.advanceTimersByTime(DEBOUNCE_MS / 2);
      }
      vi.advanceTimersByTime(DEBOUNCE_MS * 3);

      expect(changes).toEqual([join(DIR, "a.html")]);
    });
  });

  it("should ignore writes to a different file when a filename is given", () => {
    withWatcher(({ watcher, changes, fire }) => {
      watcher.add(DIR, "a.html");
      fire("change", "b.html");
      vi.advanceTimersByTime(DEBOUNCE_MS * 4);

      expect(changes).toEqual([]);
    });
  });
});

describe("createWatcher · 去抖与过滤（续）", () => {
  it("should watch the whole directory when no filename is given", () => {
    withWatcher(({ watcher, changes, fire }) => {
      watcher.add(DIR, undefined);
      fire("change", "a.html");
      vi.advanceTimersByTime(DEBOUNCE_MS * 2);
      fire("change", "b.html");
      vi.advanceTimersByTime(DEBOUNCE_MS * 2);

      // 目录事件（addDir）不算"文件变了"；归一化在 attach 层做，注入源同样被过滤。
      fire("addDir", "sub.d");
      vi.advanceTimersByTime(DEBOUNCE_MS * 2);

      expect(changes).toEqual([join(DIR, "a.html"), join(DIR, "b.html")]);
    });
  });
});

describe("createWatcher · 相邻改动不丢", () => {
  it("should deliver every debounced change — no time-window drops", () => {
    // 旧的自写回声窗会把窗口内的别进程写（MCP/CLI）整段吞掉；现在的契约是
    // 相邻两次改动各自在去抖后都送达，"算不算改"由下游字节 sha 判定。
    withWatcher(({ watcher, changes, fire }) => {
      const target = join(DIR, "a.html");
      watcher.add(DIR, "a.html");
      fire("change", "a.html");
      vi.advanceTimersByTime(DEBOUNCE_MS * 2);
      fire("change", "a.html");
      vi.advanceTimersByTime(DEBOUNCE_MS * 2);
      expect(changes).toEqual([target, target]);
    });
  });

  it("should stop reporting after close", () => {
    withWatcher(({ watcher, changes, fire }) => {
      watcher.add(DIR, "a.html");
      watcher.close();
      fire("change", "a.html");
      vi.advanceTimersByTime(DEBOUNCE_MS * 4);

      expect(changes).toEqual([]);
    });
  });
});

describe("parseDaemon · 合法形状与向前兼容", () => {
  const good = { port: 7420, token: "t", pid: 12, workspace: "/w" };

  it("should accept the exact shape", () => {
    expect(parseDaemon(JSON.stringify(good))).toEqual(good);
  });

  it("should tolerate unknown extra keys", () => {
    expect(parseDaemon(JSON.stringify({ ...good, extra: true }))).toEqual(good);
  });
});

describe("parseDaemon · 坏文件一律当“没有”", () => {
  const good = { port: 7420, token: "t", pid: 12, workspace: "/w" };

  it.each([
    ["{"],
    ["[]"],
    ["null"],
    ['{"port":7420}'],
    [JSON.stringify({ ...good, port: "7420" })],
    [JSON.stringify({ ...good, port: 0 })],
    [JSON.stringify({ ...good, port: 1.5 })],
    [JSON.stringify({ ...good, pid: -1 })],
    [JSON.stringify({ ...good, token: "" })],
    [JSON.stringify({ ...good, workspace: "" })],
  ])("should return undefined for %s", (text) => {
    expect(parseDaemon(text)).toBeUndefined();
  });
});

describe("daemon.json 的读写删", () => {
  const info = { port: 7421, token: "tok", pid: 4242, workspace: "/w" };
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hr-daemon-"));
  });

  afterEach(() => {
    for (const path of [join(home, ".hreader", "daemon.json"), join(home, ".hreader")]) {
      if (existsSync(path)) chmodSync(path, 0o700);
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("should write 0600 with no tmp residue and read it back", async () => {
    const file = await writeDaemonOf(info, home, nodePatchDeps);
    expect(file).toBe(daemonFileOf(home));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, ".hreader"))).toEqual(["daemon.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(info);
    expect(await readDaemonOf(home, nodePatchDeps)).toEqual(info);
  });

  it("should return undefined when the file is missing", async () => {
    expect(await readDaemonOf(home, nodePatchDeps)).toBeUndefined();
  });

  it("should map an unreadable daemon.json to io_failure", async () => {
    await writeDaemonOf(info, home, nodePatchDeps);
    chmodSync(daemonFileOf(home), 0o000);
    await expect(readDaemonOf(home, nodePatchDeps)).rejects.toMatchObject({ code: "io_failure" });
  });
});

describe("daemon.json 只删自己的记录", () => {
  const info = { port: 7421, token: "tok", pid: 4242, workspace: "/w" };

  it("should delete only when the pid matches", async () => {
    const home = mkdtempSync(join(tmpdir(), "hr-daemon-"));
    try {
      await writeDaemonOf(info, home, nodePatchDeps);
      expect(await removeDaemonOf(home, info.pid + 1, nodePatchDeps)).toBe(false);
      expect(await readDaemonOf(home, nodePatchDeps)).toEqual(info);
      expect(await removeDaemonOf(home, info.pid, nodePatchDeps)).toBe(true);
      expect(await readDaemonOf(home, nodePatchDeps)).toBeUndefined();
      expect(await removeDaemonOf(home, info.pid, nodePatchDeps)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("daemon 记录的进程存活判定", () => {
  const info = { port: 7421, token: "tok", pid: 4242, workspace: "/w" };

  it("should know whether the recorded pid is alive", () => {
    expect(daemonAlive({ ...info, pid: process.pid })).toBe(true);
    expect(daemonAlive({ ...info, pid: 999_999 })).toBe(false);
  });
});

/** A guaranteed-closed port: take one from the OS, then release it. Fixed ports (9 discard, 80, ...) must not be assumed free. */
const closedPort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
};

describe("portOpen · 真连接探活", () => {
  it("should see a listening port and a closed one", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    expect(await portOpen(port, 1000)).toBe(true);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    expect(await portOpen(port, 1000)).toBe(false);
  });

  it("should give up after the timeout when nothing answers", async () => {
    expect(await portOpen(await closedPort(), 50)).toBe(false);
  });
});
