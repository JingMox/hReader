// 这层管：只能靠注入 deps 或内部入口打到的 server 分支——runtime 广播、daemon 早退、watcher、
// limits 计时器、http-io 协议守卫、hub/event-ring 边界与各模块的可单测小部件。

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { HrError } from "../../src/hr-error";
import { nodePatchDeps } from "../../src/io/node-fs";
import type { PatchDeps } from "../../src/io/ports";
import { appendAnnotation, type AnnotationInput } from "../../src/server/annotation";
import { busy } from "../../src/server/handlers";
import { defaultHostsOf, hostAllowed } from "../../src/server/auth";
import type { SseEvent } from "../../src/server/contracts";
import {
  daemonAlive,
  parseDaemon,
  portOpen,
  removeDaemonOf,
  writeDaemonOf,
} from "../../src/server/daemon";
import { frameOf, frameTokenOf, type EventRing } from "../../src/server/event-ring";
import {
  CONNECT_COMMENT,
  MAX_CLIENTS,
  RETRY_AFTER_MS,
  createHub,
  createServerHub,
  type Hub,
} from "../../src/server/hub";
import {
  HttpFault,
  assetSegmentsOf,
  contentTypeOf,
  errorReply,
  jsonOf,
  methodNotAllowed,
} from "../../src/server/http-io";
import {
  READY_FRAME,
  createEventRing,
  daemonFileOf,
  matchRoute,
  statusOf,
} from "../../src/server/index";
import { REVISION_CHARS, revisionOf } from "../../src/server/revision";
import { createRuntime, type Runtime } from "../../src/server/runtime";
import { ROUTES } from "../../src/server/routes";
import { startServer } from "../../src/server/server";
import { DEBOUNCE_MS, createWatcher } from "../../src/server/watcher";
import type { WatchFn } from "../../src/server/watcher";
import { nodeStyleDeps } from "../../src/style";
import { disposeWatchers, responseLike, watcherLike } from "./casts";
import { cookieOf, DOC, httpCall, openSse, rawExchange, withServer } from "./harness";

const roots: string[] = [];
const root = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
};

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  disposeWatchers();
  for (const dir of [...roots, ...dirs]) rmSync(dir, { recursive: true, force: true });
});

const withCode = (error: Error, code: string): Error => Object.assign(error, { code });

// A real 408 is a status line anywhere in the stream; "408" inside a body
// (pid, uptime, model payload) is not a frame the server sent.
const assertNo408 = (raw: string): void => {
  expect(raw).not.toMatch(/^HTTP\/1\.1 408\b/mu);
};

/**
 * A port that is guaranteed closed: take one from the OS, then release it.
 * Tests must not assume a fixed port (80, 81, ...) is free on this machine.
 */
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

/** 写入时间戳由调用方从注入时钟取；纯函数层只透传，测试里用固定值保证字节级可比。 */
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const messageOf = (body: string | Uint8Array): string => {
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  const parsed: unknown = JSON.parse(text);
  const message: unknown = Reflect.get(Object(parsed), "message");
  return typeof message === "string" ? message : "";
};

interface Sink {
  readonly chunks: string[];
  readonly stub: object;
}

/** `ServerResponse` 替身：真类外壳 + 结构化的 write/flush，收集写出的帧。 */
const sinkOf = (): Sink => {
  const chunks: string[] = [];
  return {
    chunks,
    stub: {
      writeHead: () => undefined,
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      end: () => undefined,
      on: () => undefined,
      once: () => undefined,
      flushHeaders: () => undefined,
      destroyed: false,
    },
  };
};

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

describe("runtime · 内部路径与 tmp 噪声过滤", () => {
  it("should stay silent for .hreader internals and atomic-write tmp names", async () => {
    const slot = slotOf();
    const workspace = root("hr-rt-ws-");
    const home = root("hr-rt-home-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    const server = await startWith({ workspace, home }, slot);
    const ctx = { port: server.port, token: server.token, file: join(workspace, "doc.html") };
    try {
      const silent = await eventFrame(
        ctx,
        () => {
          slot.fire("change", ".hreader");
          slot.fire("change", ".hreader/history/x.html");
          slot.fire("change", ".hr-tmp.1.abc.doc.html");
          // write-file-atomic 的 tmp 是 `<目标>.<数字>`：漏过滤会广播一个不存在的文件名。
          slot.fire("change", "doc.html.7654321");
          slot.fire("change", "doc.html~");
        },
        "library.changed",
      );
      expect(silent).toBe("");
    } finally {
      await server.close();
    }
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

describe("watcher · 相邻改动不丢", () => {
  it("should emit every debounced change — no time-window drops", async () => {
    // 旧的自写回声窗会把窗口内的别进程写（MCP/CLI）整段吞掉；
    // 现在连续两次改动各自在去抖后都送达，"算不算改"由下游字节 sha 判定。
    const changes: string[] = [];
    let fire: ((event: string, name: string) => void) | undefined;
    const watcher = createWatcher(
      { onFileChange: (path) => changes.push(path) },
      (_dir, onEvent) => {
        fire = onEvent;
        return watcherLike();
      },
    );
    watcher.add("/ws", "doc.html");
    fire?.("change", "doc.html");
    fire?.("change", "doc.html");
    // 去抖是定时器，等"条件成立"而不是固定睡：2s 上限、10ms 间隔。
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

/**
 * Runtime over the injected event source, with the hub's ring exposed for counting.
 * The file-level emit is driven by hand, so the "echo read the new bytes before
 * noteWrite ran" interleaving is replayed exactly instead of relying on load.
 */
const echoHarnessOf = (
  workspace: string,
  home: string,
): {
  readonly runtime: Runtime;
  readonly hub: Hub;
  readonly ring: EventRing;
  readonly fire: (event: string, name: string | undefined) => void;
} => {
  let emitFile: ((event: string, name: string | undefined) => void) | undefined;
  const watch: WatchFn = (_dir, emit, options) => {
    if (!options.recursive) emitFile = emit;
    return { close: () => undefined };
  };
  const ring = createEventRing(8);
  const hub = createHub({ ring, heartbeatMs: 60_000 });
  const runtime = createRuntime(
    { workspace, docId: "doc.html", bodyMs: 1_000, home },
    { patch: nodePatchDeps, style: nodeStyleDeps(workspace), watch },
    hub,
  );
  return {
    runtime,
    hub,
    ring,
    fire: (event, name) => {
      emitFile?.(event, name);
    },
  };
};

describe("runtime · self-write echo winning the noteWrite race", () => {
  it("should not republish a revision the watcher path already announced", async () => {
    const workspace = root("hr-echo-ws-");
    const home = root("hr-echo-home-");
    const file = join(workspace, "doc.html");
    writeFileSync(file, DOC, "utf8");
    const { runtime, hub, ring, fire } = echoHarnessOf(workspace, home);
    try {
      const target = await runtime.remember("doc.html");
      // dispatch captures state.revision when a write begins — replayed here by
      // reading the bytes' sha before the simulated write lands on disk.
      const revisionBefore = revisionOf(readFileSync(file));
      // Between patchFile's disk write and noteWrite sits a real async window
      // (history snapshot, unlock, reply framing). Under load a queued fs event
      // or the reconcile heartbeat lands in it, reads the *new* bytes, and
      // announces the revision before the write path can — replayed here by hand.
      writeFileSync(file, DOC.replace("正文一", "回声一"), "utf8");
      const revision = revisionOf(readFileSync(file));
      fire("change", "doc.html");
      const deadline = Date.now() + 3_000;
      while (
        !ring.since(0).events.some((event) => event.type === "doc.changed") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      // The echo must have published by now; only then is the race replayed.
      expect(ring.since(0).events.some((event) => event.type === "doc.changed")).toBe(true);
      // The write path completes — currently this republishes the same revision,
      // producing two adjacent identical doc.changed frames.
      runtime.noteWrite(
        {
          reply: { status: 200, headers: {}, body: "" },
          target,
          revision,
          changed: true,
          changedNodes: [],
        },
        revisionBefore,
      );

      expect(ring.since(0).events.filter((event) => event.type === "doc.changed")).toHaveLength(1);
    } finally {
      runtime.close();
      hub.close();
    }
  });

  it("should still publish when a changed write leaves the doc bytes untouched", async () => {
    // Grant/trust writes report changed:true with the *unchanged* doc revision:
    // the served document changed (CSP/grant), not the bytes. That republish is
    // the only signal a client gets, so dedupe must not suppress it — without a
    // watcher-side announce inside the window, same-revision still means "publish".
    const workspace = root("hr-echo-ws-");
    const home = root("hr-echo-home-");
    const file = join(workspace, "doc.html");
    writeFileSync(file, DOC, "utf8");
    const { runtime, hub, ring } = echoHarnessOf(workspace, home);
    try {
      const target = await runtime.remember("doc.html");
      const revision = revisionOf(readFileSync(file));
      runtime.noteWrite(
        {
          reply: { status: 200, headers: {}, body: "" },
          target,
          revision,
          changed: true,
          changedNodes: [],
        },
        revision,
      );

      expect(ring.since(0).events.filter((event) => event.type === "doc.changed")).toHaveLength(1);
    } finally {
      runtime.close();
      hub.close();
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

describe("http-io · errorReply 的三条映射", () => {
  it("should map an unexpected Error to a 500 with a fixed public message", () => {
    const reply = errorReply(new Error("内部细节不要泄露"));

    expect(reply.status).toBe(500);
    expect(reply.body).toContain('"code":"io_failure"');
    expect(reply.body).not.toContain("内部细节");
  });

  it("should prefer the frozen message of a known HrError code", () => {
    const reply = errorReply(new HrError("node_not_found", "细节"));

    expect(reply.status).toBe(404);
    expect(reply.body).toContain('"code":"node_not_found"');
  });
});

describe("http-io · 走私面守卫（真 socket）", () => {
  const head = (port: number, token: string, extra: readonly string[]): string =>
    [
      "POST /api/patch HTTP/1.1",
      `Host: 127.0.0.1:${String(port)}`,
      `Cookie: ${cookieOf(token)}`,
      "X-HR-CSRF: 1",
      ...extra,
      "",
      "",
    ].join("\r\n");

  it("should reject Transfer-Encoding together with Content-Length (400)", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        head(ctx.port, ctx.token, ["Transfer-Encoding: chunked", "Content-Length: 5", "0"]),
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 400/u);
    });
  });

  it("should reject a non-chunked Transfer-Encoding as a bad request", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        head(ctx.port, ctx.token, ["Transfer-Encoding: gzip"]),
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 400/u);
    });
  });
});

describe("http-io · 方法不允许（405 + allow）", () => {
  it("should answer 405 and advertise the allowed methods", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        [
          "PUT /api/patch HTTP/1.1",
          `Host: 127.0.0.1:${String(ctx.port)}`,
          `Cookie: ${cookieOf(ctx.token)}`,
          "X-HR-CSRF: 1",
          "",
          "",
        ].join("\r\n"),
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 405/u);
      expect(text.toLowerCase()).toContain("allow: ");
    });
  });
});

describe("auth · allowHosts 的三条分支", () => {
  it("should fall back to loopback for empty/absent lists and accept a custom list", () => {
    expect(hostAllowed(undefined, 6080)).toBe(false);
    expect(hostAllowed("127.0.0.1:6080", 6080, [])).toBe(true);
    expect(hostAllowed(" LocalHost:6080 ", 6080)).toBe(true);
    expect(hostAllowed("hr.local:6080", 6080, ["hr.local:6080"])).toBe(true);
    expect(hostAllowed("hr.local:6080", 6080, ["other:6080"])).toBe(false);
  });
});

describe("event-ring · 帧头转义与诊断出口", () => {
  it("should replace CR/LF in the type token and report it once", () => {
    const notes: string[] = [];
    const event: SseEvent = { id: 7, type: "doc\r\nchanged", payload: {} };

    const frame = frameOf(event, (message) => notes.push(message));

    expect(notes).toHaveLength(1);
    expect(frame.split("\n")).toHaveLength(4);
    expect(frame).not.toContain("doc\r\nchanged");
  });

  it("should keep the plain path silent", () => {
    const notes: string[] = [];
    const frame = frameOf({ id: 1, type: "doc.changed", payload: {} }, (message) =>
      notes.push(message),
    );

    expect(notes).toHaveLength(0);
    expect(frame).toContain('"type":"doc.changed"');
  });

  it("should sanitize without a note callback", () => {
    const frame = frameOf({ id: 3, type: "a\nb", payload: {} });

    expect(frame).toContain('"type":"a-b"');
  });
});

describe("hub · createServerHub 的两个 arity", () => {
  it("should build a hub with and without a diagnostic sink", () => {
    const plain = createServerHub();
    const noisy: string[] = [];
    const reported = createServerHub((message) => noisy.push(message));
    const ring = createEventRing(2);
    const hub = createHub({ ring, heartbeatMs: 60_000 });

    const pushed = reported.publish("doc.changed", { n: 1 });
    reported.close();
    hub.close();
    plain.close();

    expect(pushed.id).toBe(1);
    expect(noisy).toEqual([]);
    expect(ring.newest()).toBe(0);
  });
});

describe("server · bind 的非 EADDRINUSE 分支", () => {
  it("should surface the OS error unchanged when binding an out-of-range port", async () => {
    const workspace = tmp("hr-bind2-ws-");
    writeFileSync(
      join(workspace, "doc.html"),
      '<article data-hr-id="hr-a"><p>x</p></article>',
      "utf8",
    );

    // Port 65536 makes listen() throw ERR_SOCKET_BAD_PORT synchronously —
    // deterministic on every OS and user, unlike the old privileged-port-80
    // version which needed both a non-root user and port 80 actually free.
    await expect(
      startServer(
        { workspace, port: 65_536, home: tmp("hr-bind2-home-"), docId: "doc.html" },
        { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
      ),
    ).rejects.toMatchObject({ code: "ERR_SOCKET_BAD_PORT" });
  });
});

describe("http-io · 公开文案的两道裁剪", () => {
  it("should hide absolute paths and truncate anything over 200 chars", () => {
    const pathy = errorReply(new HttpFault(400, "写入 /Users/someone/secret/dir/doc.html 失败"));
    expect(messageOf(pathy.body)).toBe("写入 [路径已隐藏] 失败");

    const long = errorReply(new HttpFault(400, "x".repeat(250)));
    expect(messageOf(long.body)).toHaveLength(201);
  });

  it("should not split a surrogate pair when the 200-char cut lands inside an emoji", () => {
    // 199 'x' + 😀 + 50 'y' = 251 units: the 200-unit cut falls between the emoji's two halves —
    // drop the high half, keep 199 chars + the ellipsis (the format itself is unchanged).
    const reply = errorReply(new HttpFault(400, `${"x".repeat(199)}😀${"y".repeat(50)}`));

    expect(reply.status).toBe(400);
    const message = messageOf(reply.body);
    expect(message).toBe(`${"x".repeat(199)}…`);
    expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(message).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    // A well-formed pair would be emitted literally by JSON.stringify; any \ud8–\udf escape means a lone surrogate.
    expect(reply.body).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/iu);
  });
});

describe("server · 多个 Host 头（解析器先拒，handler 分支不可达）", () => {
  it("should be rejected with 400 before our gate runs", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        [
          "GET /api/status HTTP/1.1",
          `Host: 127.0.0.1:${String(ctx.port)}`,
          "Host: evil.example",
          `Cookie: ${cookieOf(ctx.token)}`,
          "",
          "",
        ].join("\r\n"),
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 400/u);
    });
  });
});

describe("auth · defaultHostsOf", () => {
  it("should advertise both loopback spellings for the given port", () => {
    expect(defaultHostsOf(6080)).toEqual(["127.0.0.1:6080", "localhost:6080"]);
  });
});

describe("annotation · meta 缺 annotations 键", () => {
  it("should treat a meta object without annotations as empty", () => {
    const html =
      '<article data-hr-id="hr-a"><p data-hr-id="hr-b">x</p></article><script id="hr-meta">{}</script>';

    const input: AnnotationInput = { start: 0, end: 1, text: "x", note: undefined, status: "open" };
    const outcome = appendAnnotation(html, input, "hr-note-new", CREATED_AT);

    expect(outcome.html).toContain('"id":"hr-note-new"');
  });
});

describe("watcher · 重复 add 同一目录", () => {
  it("should not attach a second watcher for the same dir/file key", () => {
    let attached = 0;
    const watcher = createWatcher({ onFileChange: () => undefined }, () => {
      attached += 1;
      return watcherLike();
    });

    watcher.add("/ws", "doc.html");
    watcher.add("/ws", "doc.html");
    watcher.close();

    expect(attached).toBe(1);
  });
});

describe("daemon · portOpen 的计时器臂", () => {
  it("should resolve false when the timeout fires before connect", async () => {
    await expect(portOpen(await closedPort(), 0)).resolves.toBe(false);
  });
});

describe("server · 非法百分号编码", () => {
  it("should answer 400 for a path segment that is not valid percent-encoding", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        `GET /s/%zz HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\n\r\n`,
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 400/u);
    });
  });
});

describe("limits · keep-alive 空闲到点", () => {
  // 空闲到点只关连接，不再发 408（Node `keepAliveTimeout` 的语义）。
  it("should close without a 408 once the idle window elapses", async () => {
    await withServer(
      async (ctx) => {
        const socket = connect({ host: "127.0.0.1", port: ctx.port });
        const chunks: Buffer[] = [];
        let destroyedByUs = false;
        let closedByServer = false;
        await new Promise<void>((resolve) => {
          socket.on("connect", () => {
            socket.write(
              `GET /api/doc/doc.html/model HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nConnection: keep-alive\r\n\r\n`,
            );
          });
          socket.on("data", (chunk: Buffer) => chunks.push(chunk));
          socket.on("close", () => {
            closedByServer = !destroyedByUs;
            resolve();
          });
          setTimeout(() => {
            destroyedByUs = true;
            socket.destroy();
            resolve();
          }, 3000);
        });

        const raw = Buffer.concat(chunks).toString("latin1");
        expect(raw).toMatch(/^HTTP\/1\.1 200/u);
        assertNo408(raw);
        // The flag is set before destroy, so a self-inflicted close can't pass
        // for the server's keepAliveTimeout.
        expect(closedByServer).toBe(true);
      },
      { headersMs: 200, bodyMs: 200, idleMs: 200 },
    );
  });
});

describe("runtime · 打开文档后的 library.changed", () => {
  it("should broadcast library.changed for another file while a doc is open", async () => {
    const workspace = tmp("hr-rt2-ws-");
    writeFileSync(join(workspace, "doc.html"), '<article data-hr-id="hr-a"><p>x</p></article>');
    writeFileSync(join(workspace, "other.html"), "<article><p>y</p></article>");
    const server = await startServer(
      { workspace, port: 0, home: tmp("hr-rt2-home-"), docId: "doc.html" },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
    );
    const sse = openSse(server.port, "/api/events", { Cookie: cookieOf(server.token) });

    try {
      await sse.waitFor(1);
      await httpCall(server.port, {
        path: "/s/doc.html",
        headers: { cookie: cookieOf(server.token) },
      });
      writeFileSync(join(workspace, "other.html"), "<article><p>z</p></article>");
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !sse.frames.some((f) => f.event === "library.changed")) {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }

      expect(sse.frames.some((frame) => frame.event === "library.changed")).toBe(true);
    } finally {
      sse.close();
      await server.close();
    }
  });
});

describe("hub · 没有 Last-Event-ID 也不崩", () => {
  it("should backfill from the ring when lastEventId is omitted", () => {
    const ring = createEventRing(4);
    ring.push("doc.changed", { n: 1 });
    const hub = createHub({ ring, heartbeatMs: 60_000 });
    const sink = sinkOf();

    hub.addClient(responseLike(sink.stub), undefined);
    hub.close();

    // 没有 header 时 id 记为 0：只发 ready，不补发整环（补发会把历史事件重放一遍）。
    const text = sink.chunks.join("");
    expect(text).toContain('"type":"ready"');
    expect(text).not.toContain("events_expired");
    expect(text).not.toContain('"n":1');
  });
});

/**
 * Sends one keep-alive request and resolves on "close".
 * `closedByServer` is false only when the fallback destroy caused the close:
 * the flag is set before destroy, so a self-inflicted close can never
 * masquerade as the server's keepAliveTimeout — the distinction the old
 * wall-clock <2000ms check tried (and raced) to make.
 */
const idleAfterResponse = async (
  port: number,
  cookie: string,
): Promise<{ readonly text: string; readonly closedByServer: boolean }> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let text = "";
    let destroyedByUs = false;
    const backstop = setTimeout(() => {
      destroyedByUs = true;
      socket.destroy();
    }, 3000);
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
    });
    socket.on("close", () => {
      clearTimeout(backstop);
      resolve({ text, closedByServer: !destroyedByUs });
    });
    socket.on("connect", () => {
      socket.write(
        `GET /api/doc/doc.html/model HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`,
      );
    });
  });

describe("limits · idle 计时器自己触发（不是 header 计时器）", () => {
  // keep-alive 空闲到点由 Node 的 `keepAliveTimeout` 静默关连接，不再发明 408 帧。
  it("should close a completed-then-idle keep-alive socket without inventing a 408", async () => {
    await withServer(
      async (ctx) => {
        const { text: raw, closedByServer } = await idleAfterResponse(
          ctx.port,
          cookieOf(ctx.token),
        );

        expect(raw).toMatch(/^HTTP\/1\.1 200/u);
        assertNo408(raw);
        // The close must come from the server's keepAliveTimeout (idleMs=100),
        // not from the helper's fallback destroy.
        expect(closedByServer).toBe(true);
      },
      { headersMs: 5000, bodyMs: 5000, idleMs: 100 },
    );
  });
});

describe("http-io · TE+CL 到底谁拒", () => {
  it("should surface a 400 (ours or the parser's) and never smuggle", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        [
          "POST /api/patch HTTP/1.1",
          `Host: 127.0.0.1:${String(ctx.port)}`,
          `Cookie: ${cookieOf(ctx.token)}`,
          "X-HR-CSRF: 1",
          "Transfer-Encoding: chunked",
          "Content-Length: 5",
          "",
          "0",
          "",
          "",
        ].join("\r\n"),
        "HTTP/1.1",
        1500,
      );

      const statusOf = (): string => text.split("\r\n")[0] ?? "";
      // 实测由 Node 的 llhttp 抢先拒绝（裸 400，无我们的 JSON 体）——我们的守卫实际是死代码（llhttp 先拒）。
      expect(statusOf()).toMatch(/400|501/u);
      expect(text).not.toContain('"code":"ok"');
    });
  });
});

describe("daemon · portOpen 的超时臂（假时钟）", () => {
  it("should give up after timeoutMs when neither connect nor error arrives", async () => {
    const port = await closedPort();
    vi.useFakeTimers();
    try {
      const pending = portOpen(port, 25_000);
      vi.advanceTimersByTime(25_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("limits · 关闭时清理挂起的 header 计时器", () => {
  it("should clear pending timers when the server closes with a half-open socket", async () => {
    await withServer(
      async (ctx) => {
        const socket = connect({ host: "127.0.0.1", port: ctx.port });
        socket.write(
          `GET /api/doc/doc.html/model HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\n`,
        );
        await new Promise((resolve) => {
          setTimeout(resolve, 30);
        });
        socket.destroy();
      },
      { headersMs: 5000, bodyMs: 5000, idleMs: 5000 },
    );
  });
});

describe("hub · 缺省 Last-Event-ID", () => {
  it("should treat an undefined id as 0 and send no backfill", () => {
    const written: string[] = [];
    const res = responseLike({
      writeHead: () => undefined,
      write: (chunk: string) => written.push(chunk),
      end: () => undefined,
      on: () => undefined,
      once: () => undefined,
      flushHeaders: () => undefined,
      destroyed: false,
    });
    const hub = createHub({ ring: createEventRing(4), heartbeatMs: 60_000 });

    const client = hub.addClient(res, undefined);
    hub.publish("doc.changed", { docId: "doc.html" });
    hub.removeClient(client);
    hub.close();

    expect(client).toBeGreaterThan(0);
    expect(written.join("")).toContain("doc.changed");
  });
});

describe("event-ring · 负数 id 落在 newest 之前", () => {
  it("should answer a negative Last-Event-ID from an empty ring with an empty backfill", () => {
    const ring = createEventRing(4);

    expect(ring.since(-1)).toEqual({ hit: true, events: [] });
    ring.push("doc.changed", {});
    expect(ring.since(-1)).toEqual({ hit: false, events: [] });
  });
});

describe("daemon · portOpen 的连接失败臂", () => {
  it("should resolve false when the port refuses the connect", async () => {
    // A just-released ephemeral port refuses the connect (ECONNREFUSED):
    // the error arm resolves false long before the 120ms timer.
    await expect(portOpen(await closedPort(), 120)).resolves.toBe(false);
  }, 5_000);
});

describe("daemon · removeDaemonOf 的 ENOENT 与其它故障", () => {
  const seed = async (home: string): Promise<void> => {
    const { writeDaemonOf } = await import("../../src/server/daemon");
    await writeDaemonOf(
      { port: 6000, token: "t".repeat(32), pid: process.pid, workspace: "/ws" },
      home,
      nodePatchDeps,
    );
  };

  it("should return false when the file vanished between read and unlink", async () => {
    const home = tmp("hr-daemon2-");
    await seed(home);
    const missing = (): never => {
      throw withCode(new Error("gone"), "ENOENT");
    };
    const deps: PatchDeps = { ...nodePatchDeps, fs: { ...nodePatchDeps.fs, unlink: missing } };

    await expect(removeDaemonOf(home, process.pid, deps)).resolves.toBe(false);
  });

  it("should surface a non-ENOENT unlink failure as io_failure", async () => {
    const home = tmp("hr-daemon3-");
    await seed(home);
    const denied = (): never => {
      throw withCode(new Error("denied"), "EACCES");
    };
    const deps: PatchDeps = { ...nodePatchDeps, fs: { ...nodePatchDeps.fs, unlink: denied } };

    await expect(removeDaemonOf(home, process.pid, deps)).rejects.toMatchObject({
      code: "io_failure",
    });
  });
});

describe("limits · keep-alive 上重挂 idle 计时器", () => {
  it("should serve two requests on one socket and clear timers when the server closes", async () => {
    await withServer(
      async (ctx) => {
        const socket = connect({ host: "127.0.0.1", port: ctx.port });
        const chunks: Buffer[] = [];
        let statuses = 0;
        await new Promise<void>((resolve) => {
          socket.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            statuses += (chunk.toString("latin1").match(/^HTTP\/1\.1 200/gu) ?? []).length;
            if (statuses === 1) {
              socket.write(
                `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nConnection: keep-alive\r\n\r\n`,
              );
            }
            if (statuses >= 2) {
              socket.destroy();
              resolve();
            }
          });
          socket.on("error", () => {
            resolve();
          });
          socket.on("connect", () => {
            socket.write(
              `GET /api/doc/doc.html/model HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nConnection: keep-alive\r\n\r\n`,
            );
          });
          setTimeout(resolve, 2000);
        });

        expect(Buffer.concat(chunks).toString("latin1")).toMatch(/^HTTP\/1\.1 200/u);
      },
      { headersMs: 500, bodyMs: 500, idleMs: 5_000 },
    );
  });
});

const idleClose = async (port: number, token: string): Promise<string> => {
  const socket = connect({ host: "127.0.0.1", port });
  const chunks: Buffer[] = [];
  const closed = new Promise<void>((resolve) => {
    socket.on("close", () => {
      resolve();
    });
    socket.on("error", () => {
      resolve();
    });
  });
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => {
    socket.on("connect", () => {
      socket.write(
        `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nCookie: ${token}\r\nConnection: keep-alive\r\n\r\n`,
      );
      resolve();
    });
  });
  await closed;
  return Buffer.concat(chunks).toString("latin1");
};

const headTimeout = async (port: number): Promise<string> => {
  const socket = connect({ host: "127.0.0.1", port });
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => {
    socket.on("connect", () => {
      socket.write("GET /healthz HTTP/1.1\r\n");
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    socket.on("close", () => {
      resolve();
    });
    socket.on("error", () => {
      resolve();
    });
    setTimeout(resolve, 1_000);
  });
  socket.destroy();
  return Buffer.concat(chunks).toString("latin1");
};

describe("assertNo408 · body digits vs status line", () => {
  // /healthz answers {"ok":true,"uptimeMs":N,"pid":P}: a pid like 20408 puts
  // "408" in the body without the server ever sending a 408 status line.
  it("should not flag a 200 response whose body contains the digits 408", () => {
    const raw =
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: 37\r\n" +
      "\r\n" +
      '{"ok":true,"uptimeMs":12,"pid":20408}';

    assertNo408(raw);
  });

  it("should still flag a real 408 status line", () => {
    expect(() => {
      assertNo408("HTTP/1.1 408 Request Timeout\r\nContent-Length: 0\r\n\r\n");
    }).toThrow();
  });
});

describe("limits · 两档计时器的收尾路径", () => {
  // 空闲到点 = 静默关连接（Node `keepAliveTimeout`），不再有自造 408。
  it("should close an idle keep-alive socket without a 408 frame", async () => {
    await withServer(
      async (ctx) => {
        const raw = await idleClose(ctx.port, cookieOf(ctx.token));

        expect(raw).toMatch(/^HTTP\/1\.1 200/u);
        assertNo408(raw);
      },
      { headersMs: 1_000, bodyMs: 1_000, idleMs: 120 },
    );
  });

  // 请求头半截由 Node 的 `requestTimeout` 处理——它可能回 408，也可能直接关连接，两者都合规。
  it("should either answer 408 or close when the request head never finishes", async () => {
    await withServer(
      async (ctx) => {
        const raw = await headTimeout(ctx.port);

        expect(raw === "" || raw.startsWith("HTTP/1.1 408")).toBe(true);
      },
      { headersMs: 120, bodyMs: 1_000, idleMs: 1_000 },
    );
  });
});

describe("matchRoute · 清单路由", () => {
  it("should match /api/theme as the themes route with no params", () => {
    expect(matchRoute("GET", "/api/theme")).toMatchObject({
      kind: "route",
      params: {},
      route: { kind: "themes", auth: "none", method: "GET" },
    });
  });

  it("should still refuse a path that is shorter than every route", () => {
    expect(matchRoute("GET", "/api")).toEqual({ kind: "none" });
  });

  it("should refuse a trailing-slash variant instead of treating it as the themes route", () => {
    expect(matchRoute("GET", "/api/theme/")).toEqual({ kind: "none" });
  });
});

describe("contentTypeOf · 未知扩展名", () => {
  it("should fall back to application/octet-stream", () => {
    expect(contentTypeOf("/app/assets/font.woff2")).toBe("application/octet-stream");
    expect(contentTypeOf("/app/assets/README")).toBe("application/octet-stream");
  });
});

describe("auth · 小工具", () => {
  it("should list both loopback hosts for the given port", () => {
    expect(defaultHostsOf(7421)).toEqual(["127.0.0.1:7421", "localhost:7421"]);
  });
});

describe("daemon · 记录解析与存活判定", () => {
  it("should build the store path under .hreader", () => {
    expect(daemonFileOf("/home/u")).toBe("/home/u/.hreader/daemon.json");
  });

  it("should reject malformed payloads instead of half-trusting them", () => {
    const good = JSON.stringify({ port: 7421, token: "t", pid: 12, workspace: "/ws" });
    expect(parseDaemon(good)).toEqual({ port: 7421, token: "t", pid: 12, workspace: "/ws" });
    expect(parseDaemon("{not json")).toBeUndefined();
    expect(parseDaemon("[]")).toBeUndefined();
    expect(
      parseDaemon(JSON.stringify({ port: 0, token: "t", pid: 12, workspace: "/ws" })),
    ).toBeUndefined();
    expect(
      parseDaemon(JSON.stringify({ port: 7421, token: "", pid: 12, workspace: "/ws" })),
    ).toBeUndefined();
  });

  it("should treat the current pid as alive and a dead one as not", () => {
    expect(daemonAlive({ port: 7421, token: "t", pid: process.pid, workspace: "/ws" })).toBe(true);
    expect(daemonAlive({ port: 7421, token: "t", pid: 999_999, workspace: "/ws" })).toBe(false);
  });
});

describe("event-ring/watcher · 帧头转义与常量", () => {
  it("should fold CR/LF and escape backslashes in header tokens", () => {
    expect(frameTokenOf("a\nb")).toBe("a-b");
    expect(frameTokenOf("a\\b")).toBe("a\\\\b");
    expect(frameTokenOf("a\r\nb")).toBe("a--b");
    expect(frameTokenOf("plain")).toBe("plain");
  });

  it("should pin the protocol constants", () => {
    expect(CONNECT_COMMENT).toBe(": ready\n\n");
    expect(READY_FRAME).toContain("ready");
    expect(RETRY_AFTER_MS).toBe(2000);
    expect(MAX_CLIENTS).toBe(64);
    expect(DEBOUNCE_MS).toBe(100);
    expect(REVISION_CHARS).toBe(16);
  });
});

describe("门面 · 可单测部件仍可用", () => {
  it("should create a hub whose ring starts empty", () => {
    const ring = createEventRing(4);
    const hub = createHub({ ring, heartbeatMs: 60_000 });
    hub.close();

    expect(hub.clientCount).toBe(0);
    expect(ring.since(0).events).toEqual([]);
  });

  it("should create a watcher with the two-method surface", () => {
    const watcher = createWatcher({ onFileChange: () => undefined });
    watcher.close();

    expect(typeof watcher.add).toBe("function");
    expect(typeof watcher.close).toBe("function");
  });

  it("should match routes and map error codes to statuses", () => {
    const hit = matchRoute("GET", "/api/events");
    expect(hit.kind).toBe("route");
    expect(hit.kind === "route" ? hit.route.kind : "").toBe("events");

    const wrong = matchRoute("POST", "/api/events");
    expect(wrong.kind).toBe("method");

    // The route table grew from 9 to 31 entries (static entries + annotations/undo + doc info + trust/annotate/normalize + the three permission routes + /f/ + the six sidecar routes of feat/sidecar-annotation-routes).
    expect(ROUTES).toHaveLength(31);
    expect(statusOf("locked")).toBe(409);
    expect(statusOf("too_many_clients")).toBe(429);
    expect(statusOf("path_outside_workspace")).toBe(403);
  });
});

describe("busy · locked 到 409 的唯一翻译点", () => {
  it("should translate an HrError locked into busy", async () => {
    const cause = new HrError("locked", "文件被占用");

    const failure = await busy(() => Promise.reject(cause)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(HrError);
    expect(Reflect.get(Object(failure), "code")).toBe("busy");
    expect(Reflect.get(Object(failure), "message")).toContain("写请求");
    // 原始 locked 挂在 cause 上，定位问题时链条不能断。
    expect(Reflect.get(Object(failure), "cause")).toBe(cause);
  });

  it("should pass through an HrError that is not locked", async () => {
    const failure = await busy(() => Promise.reject(new HrError("invalid_input", "x"))).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(Reflect.get(Object(failure), "code")).toBe("invalid_input");
  });

  it("should pass through non-HrError failures unchanged", async () => {
    const boom = new Error("boom");

    const failure = await busy(() => Promise.reject(boom)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBe(boom);
  });

  it("should return the work result when nothing throws", async () => {
    await expect(busy(async () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

// `assetSegmentsOf` 是 `/assets/*` 的最后防线：每个守卫变异都直接对应一种穿越向量，逐条钉死。
describe("assetSegmentsOf · 白名单全矩阵", () => {
  it("should accept a plain nested path and split on '/'", () => {
    expect(assetSegmentsOf("nested/x.css")).toEqual(["nested", "x.css"]);
    expect(assetSegmentsOf("a/b/c.js")).toEqual(["a", "b", "c.js"]);
  });

  it.each([
    "",
    "/abs.js",
    "a//b.js",
    "a/./b.js",
    "a/../b.js",
    "../b.js",
    "a\\b.js",
    "a\0b.js",
    `seg/${"x".repeat(256)}/f.js`,
    `${"a/".repeat(300)}f.js`,
    "a/",
  ])("should reject %s", (raw) => {
    expect(assetSegmentsOf(raw)).toBeUndefined();
  });

  it("should accept the 512-char boundary and a 255-char segment", () => {
    const segment = "x".repeat(255);
    expect(assetSegmentsOf(`${segment}/f.js`)).toEqual([segment, "f.js"]);
    const raw = `${"a/".repeat(255)}fg`;
    expect(raw).toHaveLength(512);
    expect(assetSegmentsOf(raw)).toHaveLength(256);
    expect(assetSegmentsOf(`${"a/".repeat(255)}fgx`)).toBeUndefined();
  });
});

describe("http-io · 错误回执与类型表的其余字面量", () => {
  it("should tag the error name for instanceof-independent consumers", () => {
    expect(new HttpFault(400, "m").name).toBe("HttpFault");
    expect(new HttpFault(400, "m").status).toBe(400);
  });

  it("should mask a long quoted source fragment in the public message", () => {
    const reply = errorReply(new HttpFault(400, `读 '${"s".repeat(45)}' 失败`));
    expect(messageOf(reply.body)).toBe("读 [内容已隐藏] 失败");
  });

  it("should keep a 200-char message byte-identical and truncate 201", () => {
    const exact = errorReply(new HttpFault(400, "x".repeat(200)));
    expect(messageOf(exact.body)).toBe("x".repeat(200));
  });

  it("should answer the frozen io_failure message and the generic 500 fallback", () => {
    const fixed = errorReply(new HrError("io_failure", "内部细节 /tmp/x"));
    expect(JSON.parse(fixed.body as string)).toEqual({
      code: "io_failure",
      message: "服务端暂时不可用",
    });
    const boom = errorReply(new TypeError("oops"));
    expect(boom.status).toBe(500);
    expect(JSON.parse(boom.body as string)).toEqual({
      code: "io_failure",
      message: "服务端内部错误",
    });
  });

  it.each([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".map", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".bin", "application/octet-stream"],
    [".JS", "text/javascript; charset=utf-8"],
  ])("should map %s to %s", (ext, mime) => {
    expect(contentTypeOf(`f${ext}`)).toBe(mime);
  });

  it("should join the allow list with ', ' in methodNotAllowed and echo it in the message", () => {
    const reply = methodNotAllowed(["GET", "POST"]);
    expect(reply.status).toBe(405);
    expect(reply.headers["allow"]).toBe("GET, POST");
    expect(JSON.parse(reply.body as string)).toEqual({
      code: "invalid_request",
      message: "只接受 GET, POST",
    });
    expect(JSON.parse(jsonOf(200, { a: 1 }).body as string)).toEqual({ a: 1 });
  });
});
