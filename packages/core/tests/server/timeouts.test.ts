// 这层管：连接层三档超时（头/体/空闲）与畸形 `Last-Event-ID` 的既定语义——全部用极小的超时值，
// 绝不真等 10/30 秒；每个 socket 都有硬上限，挂住即失败。

import { connect } from "node:net";

import { describe, expect, it } from "vitest";

import { createEventRing } from "../../src/server/event-ring";
import { cookieOf, rawExchange, withServer, type TestServer } from "./harness";

const TINY = { headersMs: 200, bodyMs: 200, idleMs: 200 } as const;

interface Exchange {
  readonly raw: string;
  readonly closed: boolean;
}

/** 写出原文后只等"连接关闭或超时"，用来观察服务器是否主动收尾。 */
const drain = (port: number, text: string, budgetMs = 2000): Promise<Exchange> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port });
    let closed = false;
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        raw: Buffer.concat(chunks).toString("latin1"),
        closed: closed || socket.destroyed,
      });
    };
    const timer = setTimeout(finish, budgetMs);
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("close", () => {
      closed = true;
      finish();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("connect", () => socket.write(text, "latin1"));
  });

const chunkedHead = (ctx: TestServer): string =>
  [
    "POST /api/patch HTTP/1.1",
    `Host: 127.0.0.1:${String(ctx.port)}`,
    `Cookie: ${cookieOf(ctx.token)}`,
    "X-HR-CSRF: 1",
    "Content-Type: application/json",
    "Transfer-Encoding: chunked",
    "",
    "5",
    "abc",
  ].join("\r\n");

describe("timeouts · 请求体半截（slowloris）", () => {
  it("should answer 408 and close when a chunked body stalls", async () => {
    await withServer(async (ctx) => {
      const { raw, closed } = await drain(ctx.port, chunkedHead(ctx));

      expect(raw).toMatch(/^HTTP\/1\.1 408/u);
      expect(closed).toBe(true);
    }, TINY);
  });
});

describe("timeouts · 请求头半截", () => {
  // v4#2：头不完整交给 Node `requestTimeout` —— 回 408 或直接关连接都合规。
  it("should either answer 408 or close when the request line is never finished", async () => {
    await withServer(async (ctx) => {
      const { raw, closed } = await drain(ctx.port, "GET /");

      expect(closed).toBe(true);
      expect(raw === "" || raw.startsWith("HTTP/1.1 408")).toBe(true);
    }, TINY);
  });
});

describe("timeouts · keep-alive 空闲", () => {
  it("should close an idle keep-alive connection after the idle window", async () => {
    await withServer(async (ctx) => {
      const text = [
        "GET /healthz HTTP/1.1",
        `Host: 127.0.0.1:${String(ctx.port)}`,
        `Cookie: ${cookieOf(ctx.token)}`,
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n");
      const { raw, closed } = await drain(ctx.port, text, 1500);

      expect(raw).toMatch(/^HTTP\/1\.1 200/u);
      expect(closed).toBe(true);
    }, TINY);
  });
});

describe("Last-Event-ID · 畸形值（已知非目标，静默按未命中处理）", () => {
  it("should treat a malformed Last-Event-ID as 0 and never crash the stream", async () => {
    await withServer(async (ctx) => {
      const text = [
        "GET /api/events HTTP/1.1",
        `Host: 127.0.0.1:${String(ctx.port)}`,
        `Cookie: ${cookieOf(ctx.token)}`,
        "Last-Event-ID: not-a-number",
        "",
        "",
      ].join("\r\n");
      const raw = await rawExchange(ctx.port, text, "retry: 2000", 1500);

      expect(raw).toMatch(/^HTTP\/1\.1 200/u);
      expect(raw).toContain('data: {"type":"ready"}');
      expect(raw).not.toContain('"type":"reset"');
    }, TINY);
  });

  it("should map a malformed id to 0, which is a miss once the ring is trimmed (full re-fetch)", () => {
    const ring = createEventRing(2);
    ring.push("doc.changed", {});
    ring.push("doc.changed", {});
    ring.push("doc.changed", {});

    const lookup = ring.since(0);

    expect(lookup.hit).toBe(false);
    // 未命中时不补发环内事件：客户端先收到 `reset`，随后整页重取（见 hub.backfill）。
    expect(lookup.events).toEqual([]);
  });
});
