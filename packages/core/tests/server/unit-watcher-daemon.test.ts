// 这层管：`watcher.ts`（去抖 / 回声窗口 / 去重）与 `daemon.ts`（daemon.json 的解析、原子写、只删自己的）。
//
// watcher 用真盘真事件：假 FSWatcher 需要类型断言，而仓库禁用断言；真事件也更接近生产。

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
import { createWatcher, DEBOUNCE_MS, ECHO_MS, type Watcher } from "../../src/server/watcher";

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await wait(10);
  }
  return predicate();
};

interface WatchCase {
  readonly dir: string;
  readonly watcher: Watcher;
  readonly changes: string[];
  readonly setClock: (value: number) => void;
}

const withWatcher = async (run: (testCase: WatchCase) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "hr-watch-"));
  const changes: string[] = [];
  let clock = 0;
  const watcher = createWatcher({ now: () => clock, onFileChange: (path) => changes.push(path) });
  try {
    await run({ dir, watcher, changes, setClock: (value) => (clock = value) });
  } finally {
    watcher.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("createWatcher · 去抖与过滤", () => {
  it("should collapse a burst of writes into one change", async () => {
    await withWatcher(async ({ dir, watcher, changes }) => {
      watcher.add(dir, "a.html");
      for (const text of ["1", "2", "3"]) {
        writeFileSync(join(dir, "a.html"), text);
        await wait(10);
      }
      expect(await waitFor(() => changes.length > 0, 2000)).toBe(true);
      await wait(DEBOUNCE_MS * 3);
      expect(changes).toEqual([join(dir, "a.html")]);
    });
  });

  it("should ignore writes to a different file when a filename is given", async () => {
    await withWatcher(async ({ dir, watcher, changes }) => {
      watcher.add(dir, "a.html");
      await wait(50);
      writeFileSync(join(dir, "b.html"), "x");
      await wait(DEBOUNCE_MS * 4);

      expect(changes).toEqual([]);
    });
  });
});

describe("createWatcher · 去抖与过滤（续）", () => {
  it("should watch the whole directory when no filename is given", async () => {
    await withWatcher(async ({ dir, watcher, changes }) => {
      watcher.add(dir, undefined);
      await wait(50); // fs.watch 注册完成前写入会丢事件（真盘竞态，非实现问题）
      writeFileSync(join(dir, "a.html"), "x");
      expect(await waitFor(() => changes.includes(join(dir, "a.html")), 2000)).toBe(true);
      writeFileSync(join(dir, "b.html"), "y");
      expect(await waitFor(() => changes.includes(join(dir, "b.html")), 2000)).toBe(true);

      // 真盘上目录监听会顺带报一次“目录自身”的事件（名字 = 目录名），处理器必须容忍它。
      expect(changes.filter((path) => path.endsWith(".html")).sort()).toEqual([
        join(dir, "a.html"),
        join(dir, "b.html"),
      ]);
    });
  });
});

describe("createWatcher · 自身写入回声", () => {
  it("should swallow the echo inside the window, then deliver after it", async () => {
    await withWatcher(async ({ dir, watcher, changes, setClock }) => {
      const target = join(dir, "a.html");
      watcher.add(dir, "a.html");
      watcher.noteSelfWrite(target);
      writeFileSync(target, "1");
      setClock(ECHO_MS - 1);
      expect(await waitFor(() => changes.length === 0, 400)).toBe(true);
      await wait(DEBOUNCE_MS * 2);
      expect(changes).toEqual([]);

      setClock(ECHO_MS * 10);
      writeFileSync(target, "2");
      expect(await waitFor(() => changes.length === 1, 2000)).toBe(true);
      expect(changes).toEqual([target]);
    });
  });

  it("should stop reporting after close", async () => {
    await withWatcher(async ({ dir, watcher, changes }) => {
      watcher.add(dir, "a.html");
      watcher.close();
      writeFileSync(join(dir, "a.html"), "x");
      await wait(DEBOUNCE_MS * 4);

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
    expect(await portOpen(9, 50)).toBe(false);
  });
});
