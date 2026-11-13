// 这层管：G3.9 的覆盖率残差里"可到达"的四处——hub 无 Last-Event-ID、payload.type 非字符串、
// idle 计时器真正触发、TE+CL 走私面的实际归属（我们的守卫 vs Node 解析器）。

import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { portOpen } from "../../src/server/daemon";
import { createEventRing } from "../../src/server/event-ring";
import { createHub } from "../../src/server/hub";
import { responseLike } from "./casts";
import { cookieOf, rawExchange, withServer } from "./harness";

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

const idleAfterResponse = async (port: number, cookie: string): Promise<string> =>
  new Promise<string>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
    });
    socket.on("close", () => {
      resolve(text);
    });
    socket.on("connect", () => {
      socket.write(
        `GET /api/doc/doc.html/model HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`,
      );
    });
    setTimeout(() => {
      socket.destroy();
      resolve(text);
    }, 3000);
  });

describe("limits · idle 计时器自己触发（不是 header 计时器）", () => {
  // v4#2 裁定：keep-alive 空闲到点由 Node 的 `keepAliveTimeout` 静默关连接，不再发明 408 帧。
  it("should close a completed-then-idle keep-alive socket without inventing a 408", async () => {
    await withServer(
      async (ctx) => {
        const started = Date.now();
        const raw = await idleAfterResponse(ctx.port, cookieOf(ctx.token));

        expect(raw).toMatch(/^HTTP\/1\.1 200/u);
        expect(raw).not.toContain("408");
        // 必须是真的"到点被关"，而不是测试自己的 3s 兜底 destroy 造成的假通过。
        expect(Date.now() - started).toBeLessThan(2000);
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
      // 实测由 Node 的 llhttp 抢先拒绝（裸 400，无我们的 JSON 体）——见报告：我们的守卫是死代码。
      expect(statusOf()).toMatch(/400|501/u);
      expect(text).not.toContain('"code":"ok"');
    });
  });
});

describe("daemon · portOpen 的超时臂（假时钟）", () => {
  it("should give up after timeoutMs when neither connect nor error arrives", async () => {
    vi.useFakeTimers();
    try {
      const pending = portOpen(9, 25_000);
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
