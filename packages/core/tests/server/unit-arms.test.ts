// 这层管：单点分支的补强——hub/daemon/watcher/runtime/server 的边角 + 门面导出。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeWatchers, responseLike, watcherLike } from "./casts";
import { afterAll, describe, expect, it, vi } from "vitest";

import * as facade from "../../src/server";
import { createEventRing } from "../../src/server/event-ring";
import { CONNECT_COMMENT, createHub } from "../../src/server/hub";
import { createWatcher } from "../../src/server/watcher";
import { daemonFileOf, readDaemonOf, removeDaemonOf, writeDaemonOf } from "../../src/server/daemon";
import { nodePatchDeps } from "../../src/io/node-fs";
import { HrError } from "../../src/hr-error";
import { startServer } from "../../src/server/server";
import { nodeStyleDeps } from "../../src/style";

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), "hr-arms-")));

const fakeRes = () => {
  const writes: string[] = [];
  const writesHead: unknown[] = [];
  const flushed = { count: 0 };
  const ends = { count: 0 };
  return {
    writes,
    writesHead,
    flushed,
    ends,
    on: () => undefined,
    write: (chunk: string) => writes.push(chunk),
    end: (chunk?: string) => {
      ends.count += 1;
      if (chunk !== undefined) writes.push(chunk);
    },
    writeHead: (...args: unknown[]) => writesHead.push(args),
    flushHeaders: () => {
      flushed.count += 1;
    },
  };
};

describe("hub · 连接表", () => {
  it("should fan out published events, count clients, remove and close them", () => {
    const hub = createHub({ ring: createEventRing(4), heartbeatMs: 60_000 });
    const res = fakeRes();
    const id = hub.addClient(responseLike(res), undefined);

    expect(hub.clientCount).toBe(1);
    expect(res.flushed.count).toBe(1);
    hub.publish("doc.changed", { a: 1 });
    expect(res.writes.some((chunk) => chunk.includes("doc.changed"))).toBe(true);
    hub.removeClient(id);
    expect(hub.clientCount).toBe(0);
    const res2 = fakeRes();
    hub.addClient(responseLike(res2), undefined);
    hub.close();
    expect(res2.ends.count).toBe(1);
    expect(hub.clientCount).toBe(0);
  });

  it("should write keep-alive frames on the heartbeat", () => {
    vi.useFakeTimers();
    try {
      const hub = createHub({ ring: createEventRing(2), heartbeatMs: 10 });
      const res = fakeRes();
      hub.addClient(responseLike(res), undefined);
      vi.advanceTimersByTime(25);
      expect(
        res.writes.filter((chunk) => chunk === ": keep-alive\n\n").length,
      ).toBeGreaterThanOrEqual(2);
      hub.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hub · Last-Event-ID 解析", () => {
  it("should treat undefined/blank/NaN/negative as 0 and replay from the ring start", () => {
    const ring = createEventRing(4);
    const hub = createHub({ ring, heartbeatMs: 60_000 });
    ring.push("doc.changed", { n: 1 });
    ring.push("doc.changed", { n: 2 });

    const absent = fakeRes();
    hub.addClient(responseLike(absent), undefined);
    expect(absent.writes.filter((chunk) => chunk.includes("doc.changed"))).toHaveLength(0);
    expect(absent.writes.filter((chunk) => chunk.includes('"type":"ready"'))).toHaveLength(1);
    expect(absent.writes[0]).toBe(CONNECT_COMMENT);

    for (const raw of ["", "   ", "abc", "-3", "1.5"]) {
      const res = fakeRes();
      hub.addClient(responseLike(res), raw);
      const replayed = res.writes.filter((chunk) => chunk.includes("doc.changed")).length;
      expect(replayed).toBe(2);
    }
    const valid = fakeRes();
    hub.addClient(responseLike(valid), "1");
    expect(valid.writes.filter((chunk) => chunk.includes("doc.changed"))).toHaveLength(1);
    hub.close();
  });
});

describe("watcher · 回调过滤", () => {
  const harness = (): {
    readonly fire: (name: string | undefined) => void;
    readonly changes: string[];
  } => {
    const changes: string[] = [];
    let callback: ((event: string, name: string | undefined) => void) | undefined;
    const watcher = createWatcher(
      { onFileChange: (path) => changes.push(path) },
      (_dir, onEvent) => {
        callback = onEvent;
        return watcherLike();
      },
    );
    watcher.add("/ws", "doc.html");
    return {
      fire: (name) => callback?.("change", name),
      changes,
    };
  };

  it("should ignore an undefined filename and a different file", () => {
    vi.useFakeTimers();
    try {
      const { fire, changes } = harness();
      fire(undefined);
      fire("other.html");
      vi.advanceTimersByTime(500);
      expect(changes).toEqual([]);
      fire("doc.html");
      vi.advanceTimersByTime(500);
      expect(changes).toEqual(["/ws/doc.html"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("daemon · 失败与自删", () => {
  it("should map a rename failure to io_failure", async () => {
    const home = tmp();
    const deps = {
      ...nodePatchDeps,
      fs: {
        ...nodePatchDeps.fs,
        rename: async () => {
          await Promise.resolve();
          throw Object.assign(new Error("boom"), { code: "EXDEV" });
        },
      },
    };
    try {
      await expect(
        writeDaemonOf({ port: 1, token: "t", pid: 1, workspace: "/w" }, home, deps),
      ).rejects.toMatchObject({ code: "io_failure" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("should not remove a daemon.json owned by another pid", async () => {
    const home = tmp();
    try {
      await writeDaemonOf(
        { port: 1, token: "t", pid: process.pid, workspace: "/w" },
        home,
        nodePatchDeps,
      );
      expect(await removeDaemonOf(home, process.pid + 1, nodePatchDeps)).toBe(false);
      expect(await removeDaemonOf(home, process.pid, nodePatchDeps)).toBe(true);
      expect(await removeDaemonOf(home, process.pid, nodePatchDeps)).toBe(false);
      expect(await readDaemonOf(home, nodePatchDeps)).toBeUndefined();
      expect(daemonFileOf(home)).toContain("daemon.json");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("daemon · 失败与自删（续）", () => {
  it("should map an unlink failure that is not ENOENT to io_failure", async () => {
    const home = tmp();
    try {
      await writeDaemonOf(
        { port: 1, token: "t", pid: process.pid, workspace: "/w" },
        home,
        nodePatchDeps,
      );
      const deps = {
        ...nodePatchDeps,
        fs: {
          ...nodePatchDeps.fs,
          unlink: async () => {
            await Promise.resolve();
            throw Object.assign(new Error("nope"), { code: "EACCES" });
          },
        },
      };
      await expect(removeDaemonOf(home, process.pid, deps)).rejects.toMatchObject({
        code: "io_failure",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("server · 端口占用与关闭", () => {
  it("should map EADDRINUSE to port_in_use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const workspace = tmp();
    const home = tmp();
    try {
      writeFileSync(
        join(workspace, "doc.html"),
        '<article data-hr-id="hr-a"><p data-hr-id="hr-b">x</p></article>',
      );
      await expect(
        startServer(
          { workspace, port, home, docId: "doc.html" },
          { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
        ),
      ).rejects.toMatchObject({ code: "port_in_use" });
    } finally {
      blocker.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("facade · 导出面", () => {
  it("should expose the documented runtime exports", () => {
    expect(facade.startServer).toBeTypeOf("function");
    expect(facade.createEventRing).toBeTypeOf("function");
    expect(facade.createHub).toBeTypeOf("function");
    expect(facade.createWatcher).toBeTypeOf("function");
    expect(facade.matchRoute).toBeTypeOf("function");
    expect(facade.statusOf("busy")).toBe(503);
    expect(JSON.stringify(facade.READY_FRAME)).toContain("ready");
    expect(facade.daemonFileOf("/h")).toBe("/h/.hreader/daemon.json");
    expect(HrError).toBeTypeOf("function");
  });
});

describe("writeDaemonOf · 正常路径", () => {
  it("should write a 0600 daemon.json that reads back", async () => {
    const home = tmp();
    try {
      const file = await writeDaemonOf(
        { port: 2, token: "abc", pid: process.pid, workspace: "/w" },
        home,
        nodePatchDeps,
      );
      expect(file).toBe(join(home, ".hreader", "daemon.json"));
      expect(await readDaemonOf(home, nodePatchDeps)).toMatchObject({ port: 2 });
      writeFileSync(join(home, ".hreader", "daemon.json"), "{bad", "utf8");
      expect(await readDaemonOf(home, nodePatchDeps)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  disposeWatchers();
});
