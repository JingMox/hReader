// 这层管：v4#1 的三条 SSE 防线——首帧注释、429 自带重试间隔并关连接、5xx 广播成 error 事件。

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { startServer } from "../../src/server/server";
import { createHub } from "../../src/server/hub";
import { createEventRing } from "../../src/server/event-ring";
import { MAX_CLIENTS, RETRY_AFTER_MS } from "../../src/server/hub";
import { nodePatchDeps } from "../../src/io/node-fs";
import { nodeStyleDeps } from "../../src/style";
import { responseLike } from "./casts";
import { cookieOf, httpCall, openSse, rawExchangeUntil } from "./harness";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

const bootOf = async (): Promise<{
  port: number;
  token: string;
  close: () => Promise<void>;
  workspace: string;
}> => {
  const workspace = tmp("hr-v4-ws-");
  writeFileSync(
    join(workspace, "doc.html"),
    '<article data-hr-id="hr-a"><p data-hr-id="hr-b">x</p></article>',
    "utf8",
  );
  const server = await startServer(
    { workspace, port: 0, home: tmp("hr-v4-home-"), docId: "doc.html" },
    { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
  );
  return {
    port: server.port,
    token: server.token,
    close: async () => {
      await server.close();
    },
    workspace,
  };
};

describe("v4#1a · 首帧是注释心跳", () => {
  it("should write a comment frame before the ready event", async () => {
    const boot = await bootOf();
    const sse = openSse(boot.port, "/api/events", { Cookie: cookieOf(boot.token) });

    try {
      await sse.waitFor(1);
      const text = await rawExchangeUntil(
        boot.port,
        `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${String(boot.port)}\r\nCookie: ${cookieOf(boot.token)}\r\n\r\n`,
        (raw) => raw.includes(": ready"),
      );
      expect(text).toContain(": ready");
      expect(text.indexOf(": ready")).toBeLessThan(text.indexOf("data:"));
      expect(sse.frames[0]?.event).toBe("ready");
      expect(sse.frames[0]?.id).toBe(0);
    } finally {
      sse.close();
      await boot.close();
    }
  });
});

describe("v4#1c · 第 65 个连接", () => {
  it("should answer 429 with retryAfterMs and close the socket", async () => {
    const boot = await bootOf();
    const clients = Array.from({ length: MAX_CLIENTS }, () =>
      openSse(boot.port, "/api/events", { Cookie: cookieOf(boot.token) }),
    );

    try {
      for (const client of clients) await client.waitFor(1);
      const overflow = await httpCall(boot.port, {
        path: "/api/events",
        headers: { cookie: cookieOf(boot.token) },
      });

      expect(overflow.status).toBe(429);
      expect(JSON.parse(overflow.body)).toMatchObject({
        code: "too_many_clients",
        retryAfterMs: RETRY_AFTER_MS,
      });
      expect(overflow.headers["retry-after"]).toBe(String(RETRY_AFTER_MS / 1_000));
      expect(overflow.headers["connection"]).toBe("close");
    } finally {
      for (const client of clients) client.close();
      await boot.close();
    }
  }, 30_000);
});

describe("v4#1b · 5xx 广播成 error 事件", () => {
  it("should broadcast an error frame instead of silently dropping the stream", async () => {
    const boot = await bootOf();
    const sse = openSse(boot.port, "/api/events", { Cookie: cookieOf(boot.token) });

    try {
      await sse.waitFor(1);
      chmodSync(join(boot.workspace, "doc.html"), 0o000);
      const failed = await httpCall(boot.port, {
        path: "/s/doc.html",
        headers: { cookie: cookieOf(boot.token) },
      });
      // 5xx 由 fs.chmod 触发，watcher 可能额外插 `doc.error` / `library.changed`：只等 `error` 事件，不数帧。
      const errorFrame = await sse.waitForEvent("error");
      const errorFrames = sse.frames.filter((frame) => frame.event === "error");

      expect(failed.status).toBe(500);
      expect(errorFrames).toHaveLength(1);
      expect(errorFrame.data).toContain('"io_failure"');
    } finally {
      sse.close();
      await boot.close();
    }
  });
});

describe("v4#1b · 事件类型里的换行（反向变异的靶子）", () => {
  it("should escape CR/LF inside the type so the data line stays one JSON line", () => {
    const frames: string[] = [];
    const hub = createHub({ ring: createEventRing(2), heartbeatMs: 60_000 });
    hub.publish("x\nevil: 1\rid: 99", { n: 1 });
    hub.addClient(
      responseLike({
        writeHead: () => undefined,
        write: (chunk: string) => frames.push(chunk),
        end: () => undefined,
        on: () => undefined,
        once: () => undefined,
        flushHeaders: () => undefined,
        destroyed: false,
      }),
      "0",
    );
    hub.close();

    const dataLine = frames
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .at(-1);
    expect(dataLine).toBeDefined();
    const parsed: unknown = JSON.parse((dataLine ?? "").slice(6));
    expect(parsed).toMatchObject({ type: "x-evil: 1-id: 99" });
    expect(
      frames
        .join("")
        .split("\n")
        .some((line) => line.startsWith("evil: ")),
    ).toBe(false);
  });
});

const listenOn = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

const portOf = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("没有监听端口");
  return address.port;
};

describe("R2 · 兜底定时器与断连自证", () => {
  it("should clear one socket life timer per connection on close", async () => {
    const boot = await bootOf();
    // 只 fake 定时器：socket 的真实事件不受影响，本用例也不靠真实时钟等帧。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const baseline = vi.getTimerCount();
      const clients = Array.from({ length: 3 }, () =>
        openSse(boot.port, "/api/events", { Cookie: cookieOf(boot.token) }),
      );
      // 每条连接一个 `SOCKET_LIFE_MS` 兜底定时器；deadline 定时器只在 `waitFor` 里建，这里不 waitFor。
      expect(vi.getTimerCount() - baseline).toBe(3);
      for (const client of clients) client.close();
      // 看的是**效果**不是调用：`close()` 里没 clearTimeout 的话，三条 60s 兜底定时器还挂着，计数回不到基线。
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
      await boot.close();
    }
  });
});

/** 服务端收到首帧请求就关流：制造「服务端先断连」的确定性场景（两条断连用例共用）。 */
const withEndingServer = async (run: (port: number) => Promise<void>): Promise<void> => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end());
  });
  await listenOn(server);
  try {
    await run(portOf(server));
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
};

describe("R2 · 断连自证", () => {
  it("should reject with the socket error instead of waiting out the deadline", async () => {
    // 连保留端口 1：内核不会把 1 分给临时 server，比「bind 后立即 close」少一个复用窗口。
    const sse = openSse(1, "/api/events");
    try {
      // 不锚死 `ECONNREFUSED`：具体 errno 随内核/平台不同，但都走同一条 `error` 分支。
      await expect(sse.waitFor(1)).rejects.toThrow(/连接已关闭（socket 错误：/u);
    } finally {
      sse.close();
    }
  });

  it("should reject when the server ends the stream, then stay idempotent on repeated close", async () => {
    await withEndingServer(async (port) => {
      const sse = openSse(port, "/api/events");
      try {
        await expect(sse.waitFor(1)).rejects.toThrow("连接已关闭（socket 已关闭）");
        // 幂等：服务端已关，`close()` 连调两次不把第一次的原因覆盖成显式关闭（`""`）。
        sse.close();
        sse.close();
        // 这里只有一条断言：幂等性由下面这条 `waitFor` 的状态断言覆盖；`not.toThrow()` 恒真（`close()` 只做
        // `shutdown("")` + `socket.destroy()`，两者都不抛）、`frames` 长度也恒为 0（该场景服务端从不下发帧），故都不写。
        await expect(sse.waitFor(1)).rejects.toThrow("连接已关闭（socket 已关闭）");
      } finally {
        sse.close();
      }
    });
  });
});
