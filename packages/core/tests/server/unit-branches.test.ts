// 这层管：只有"注入 deps"才能打到的分支——runtime 的 doc.error / library.changed / 无变化不广播、
// ensureNoDaemon 的三条早退、bodyRecordOf 的非 JSON、watcher 回声窗口过期。

import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { bodyRecordOf } from "../../src/server/http-io";
import { disposeWatchers, requestLike, watcherLike } from "./casts";
import { createWatcher } from "../../src/server/watcher";
import type { WatchFn } from "../../src/server/watcher";
import { writeDaemonOf, daemonFileOf } from "../../src/server/daemon";
import { nodePatchDeps } from "../../src/io/node-fs";
import { nodeStyleDeps } from "../../src/style";
import { startServer } from "../../src/server/server";
import { cookieOf, DOC, httpCall, openSse, withServer } from "./harness";
import { mkdirSync } from "node:fs";

const roots: string[] = [];
const root = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  disposeWatchers();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface WatchSlot {
  /** `remember` 会给同一目录再挂一个带文件名的 watcher，所以回调是多个：全部触发。 */
  readonly fires: ((event: string, name: string | undefined) => void)[];
  readonly fire: (event: string, name: string | undefined) => void;
}

const slotOf = (): WatchSlot => {
  const fires: ((event: string, name: string | undefined) => void)[] = [];
  return {
    fires,
    fire: (event, name) => {
      for (const one of fires) one(event, name);
    },
  };
};

const recordingWatch =
  (slot: WatchSlot): WatchFn =>
  (_dir, onEvent) => {
    slot.fires.push(onEvent);
    return watcherLike();
  };

const startWith = async (
  ctx: { readonly workspace: string; readonly home: string },
  slot: WatchSlot,
): Promise<{
  readonly close: () => Promise<void>;
  readonly port: number;
  readonly token: string;
}> => {
  const server = await startServer(
    {
      workspace: ctx.workspace,
      port: 0,
      home: ctx.home,
      docId: "doc.html",
    },
    {
      patch: nodePatchDeps,
      style: nodeStyleDeps(ctx.workspace),
      now: Date.now,
      watch: recordingWatch(slot),
    },
  );
  return server;
};

interface FrameCtx {
  readonly port: number;
  readonly token: string;
  readonly file: string;
}

const eventFrame = async (ctx: FrameCtx, fire: () => void, waitFor: string): Promise<string> => {
  const sse = openSse(ctx.port, "/api/events", { cookie: cookieOf(ctx.token) });
  try {
    await sse.waitFor(1);
    if (sse.frames.length === 0) throw new Error(`SSE 没有 ready 帧（端口 ${String(ctx.port)}）`);
    await httpCall(ctx.port, { path: "/s/doc.html", headers: { cookie: cookieOf(ctx.token) } });
    fire();
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const hit = sse.frames.find((frame) => frame.event === waitFor);
      if (hit === undefined) process.stderr.write(`FRAMES ${JSON.stringify(sse.frames)}\n`);
      if (hit !== undefined) return hit.data;
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return "";
  } finally {
    sse.close();
  }
};

describe("runtime · 注入 watch 的广播分支", () => {
  it("should broadcast library.changed for an unrelated file and doc.error for a vanished doc", async () => {
    const slot = slotOf();
    const workspace = root("hr-rt-ws-");
    const home = root("hr-rt-home-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    writeFileSync(join(workspace, "other.html"), DOC, "utf8");
    const server = await startWith({ workspace, home }, slot);
    const ctx = { port: server.port, token: server.token, file: join(workspace, "doc.html") };
    try {
      const library = await eventFrame(
        ctx,
        () => {
          slot.fire("change", "other.html");
        },
        "library.changed",
      );
      expect(library).toContain("other.html");

      unlinkSync(ctx.file);
      const error = await eventFrame(
        ctx,
        () => {
          slot.fire("change", "doc.html");
        },
        "doc.error",
      );
      expect(error).toContain("doc.html");
    } finally {
      await server.close();
    }
  });
});

describe("runtime · 注入 watch 的广播分支（续）", () => {
  it("should stay silent when the file is rewritten with identical content", async () => {
    const slot = slotOf();
    await withServer(async (ctx) => {
      const silent = await eventFrame(
        ctx,
        () => {
          writeFileSync(ctx.file, DOC, "utf8");
          slot.fire("change", "doc.html");
        },
        "doc.changed",
      );
      expect(silent).toBe("");
    });
  });
});

describe("ensureNoDaemon · 三条早退", () => {
  it("should start when the recorded daemon is dead", async () => {
    const workspace = root("hr-daemon-ws-");
    const home = root("hr-daemon-home-");
    mkdirSync(join(home, ".hreader"), { recursive: true });
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    await writeDaemonOf({ port: 9, token: "t", pid: 999_999, workspace }, home, nodePatchDeps);
    const server = await startServer(
      { workspace, port: 0, home, docId: "doc.html" },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
    );
    expect(server.port).toBeGreaterThan(0);
    await server.close();
  });
});

describe("ensureNoDaemon · 三条早退（续）", () => {
  it("should start when the recorded pid is alive but its port is closed", async () => {
    const workspace = root("hr-daemon2-ws-");
    const home = root("hr-daemon2-home-");
    mkdirSync(join(home, ".hreader"), { recursive: true });
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await writeDaemonOf({ port, token: "t", pid: process.pid, workspace }, home, nodePatchDeps);
    blocker.close();
    const server = await startServer(
      { workspace, port: 0, home, docId: "doc.html" },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
    );
    expect(server.port).toBeGreaterThan(0);
    expect(daemonFileOf(home)).toContain("daemon.json");
    await server.close();
  });
});

describe("http-io · 请求体只接受 JSON 对象", () => {
  const bodyOf = (text: string): ReturnType<typeof bodyRecordOf> => {
    const req = {
      on: (event: string, handler: (chunk?: Buffer) => void) => {
        if (event === "data") handler(Buffer.from(text));
        if (event === "end") handler();
        return req;
      },
    };
    return bodyRecordOf(requestLike(req));
  };

  it("should accept a JSON object", async () => {
    await expect(bodyOf('{"a":1}')).resolves.toEqual({ a: 1 });
  });

  it.each([["not-json"], ["[]"], ["null"], ["1"], ['"x"'], ["{"], ["{}x"]])(
    "should throw invalid_request for %j",
    async (text) => {
      await expect(bodyOf(text)).rejects.toMatchObject({ code: "invalid_request" });
    },
  );
});

describe("watcher · 回声窗口过期后仍要转发", () => {
  it("should emit once the self-write echo window has passed", async () => {
    let now = 1000;
    const changes: string[] = [];
    let fire: ((event: string, name: string) => void) | undefined;
    const watcher = createWatcher(
      { now: () => now, onFileChange: (path) => changes.push(path) },
      (_dir, onEvent) => {
        fire = onEvent;
        return watcherLike();
      },
    );
    watcher.add("/ws", "doc.html");
    watcher.noteSelfWrite("/ws/doc.html");
    fire?.("change", "doc.html");
    now += 10_000;
    fire?.("change", "doc.html");
    // 去抖是定时器 + 回声窗口，等"条件成立"而不是固定睡 300ms：2s 上限、10ms 间隔。
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && changes.length === 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    try {
      expect(changes).toEqual(["/ws/doc.html"]);
    } finally {
      watcher.close();
    }
  });
});

describe("startServer · 端口被占用", () => {
  it("should reject with port_in_use", async () => {
    const workspace = root("hr-bind-ws-");
    const home = root("hr-bind-home-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      await expect(
        startServer(
          { workspace, port, home, docId: "doc.html" },
          { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
        ),
      ).rejects.toMatchObject({ code: "port_in_use" });
    } finally {
      blocker.close();
    }
  });
});
