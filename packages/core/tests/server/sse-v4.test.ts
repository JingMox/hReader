// 这层管：v4#1 的三条 SSE 防线——首帧注释、429 自带重试间隔并关连接、5xx 广播成 error 事件。

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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
      const frames = await sse.waitFor(3);
      const errorFrame = frames.find((frame) => frame.event === "error");

      expect(failed.status).toBe(500);
      expect(errorFrame?.data).toContain('"io_failure"');
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
