// 这层管：SSE 帧的逐字节形状——id 单调、data 单行、Last-Event-ID 两路、第 65 个连接 429。

import { connect } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, httpCall, openSse, type SseFrame, withServer } from "./harness";
import { withPost } from "./wire";

// 追加到 <p>（hr-d）的片段必须是行内内容：块级子节点会被 F6 的内容模型校验拒掉，
// 而本文件的用例只关心“帧的形状”，不关心插进去的是段落还是强调。
const bodyOf = (fragment: string): string =>
  JSON.stringify({ docId: "doc.html", action: "append", targetId: "hr-d", fragment });

const send = async (port: number, token: string, fragment: string): Promise<number> => {
  const response = await httpCall(port, {
    method: "POST",
    path: "/api/patch",
    headers: withPost(token),
    body: bodyOf(fragment),
  });
  return response.status;
};

/** 有界轮询：等条件成立（10ms 间隔，默认 3s 上界），超时把当前帧表打出来。 */
const untilFrames = async (
  sse: { frames: readonly SseFrame[] },
  predicate: (frames: readonly SseFrame[]) => boolean,
  timeoutMs = 3000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate(sse.frames)) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  if (!predicate(sse.frames)) throw new Error(`等帧超时；现有：${JSON.stringify(sse.frames)}`);
};

const isDocChanged = (frame: SseFrame): boolean => frame.data.includes('"type":"doc.changed"');

/** doc.changed 只增不减（library.changed 可能插在中间，所以只看过滤后的 id 序列）。 */
const expectMonotonic = (frames: readonly SseFrame[]): void => {
  const changed = frames.filter(isDocChanged);
  expect(changed.length).toBeGreaterThanOrEqual(2);
  const ids = changed.map((frame) => frame.id ?? -1);
  for (let index = 1; index < ids.length; index += 1) {
    expect(ids[index] ?? -1).toBeGreaterThan(ids[index - 1] ?? -1);
  }
  for (const frame of changed) expect(frame.data).toContain('"docId":"doc.html"');
};

/** 帧类型只能来自已知集合；library.changed 必带 path（一次写入同时产生两种事件是事实）。 */
const expectKnownKinds = (frames: readonly SseFrame[]): void => {
  const known = new Set(["ready", "doc.changed", "library.changed"]);
  for (const frame of frames) expect(known.has(frame.event)).toBe(true);
  for (const frame of frames.filter((item) => item.event === "library.changed")) {
    expect(frame.data).toContain('"path"');
  }
};

describe("sse · ready 与事件", () => {
  it("should emit the byte-exact ready frame first", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      sse.close();

      expect(sse.frames[0]).toEqual({ id: 0, event: "ready", data: '{"type":"ready"}' });
    });
  });
});

describe("sse · patch 事件与转义", () => {
  it("should publish one doc.changed per write with strictly increasing ids", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      expect(await send(ctx.port, ctx.token, "<b>一</b>")).toBe(200);
      expect(await send(ctx.port, ctx.token, "<b>二</b>")).toBe(200);
      await untilFrames(sse, (frames) => frames.filter(isDocChanged).length >= 2);
      sse.close();

      // 一次写入会同时触发 doc.changed 与 library.changed（工作区清单变了），所以只对 doc.changed 断言数量与单调。
      expectMonotonic(sse.frames);
      expectKnownKinds(sse.frames);
    });
  });
});

describe("sse · 外部文件与转义", () => {
  it("should keep the two event kinds independent when an external file appears", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      expect(await send(ctx.port, ctx.token, "<b>x</b>")).toBe(200);
      writeFileSync(join(ctx.workspace, "extra.html"), "<article><p>y</p></article>");
      // 去抖后才会把新文件报出来：等"含 extra.html 的 library.changed"出现，而不是等任意一条。
      await untilFrames(sse, (frames) =>
        frames.some(
          (frame) => frame.event === "library.changed" && frame.data.includes("extra.html"),
        ),
      );
      sse.close();

      expect(sse.frames.filter(isDocChanged).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("should escape newlines in the fragment so no extra frame is forged", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      expect(await send(ctx.port, ctx.token, "<b>a\nb</b>")).toBe(200);
      await untilFrames(sse, (frames) => frames.some(isDocChanged));
      sse.close();

      const changed = sse.frames.filter(isDocChanged);
      expect(changed.length).toBeGreaterThanOrEqual(1);
      for (const frame of changed) expect(frame.data.split("data:")).toHaveLength(1);
    });
  });
});

describe("sse · 帧转义（换行不能伪造新帧）", () => {
  it("should escape a newline in the file name so it cannot forge a second frame", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      writeFileSync(join(ctx.workspace, "we\nird.html"), "<article><p>x</p></article>");
      const deadline = Date.now() + 3000;
      let frame = sse.frames.find((candidate) => candidate.data.includes("ird.html"));
      while (frame === undefined && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        frame = sse.frames.find((candidate) => candidate.data.includes("ird.html"));
      }
      sse.close();
      if (frame === undefined) throw new Error("三秒内没有收到含 ird.html 的帧");

      expect(frame.data).toContain("we\\nird.html");
      expect(frame.data.split("\n")).toHaveLength(1);
    });
  });
});

describe("sse · Last-Event-ID 命中", () => {
  it("should backfill only the missed event on a hit (no reset)", async () => {
    await withServer(async (ctx) => {
      await send(ctx.port, ctx.token, "<b>一</b>");
      await send(ctx.port, ctx.token, "<b>二</b>");
      const sse = openSse(ctx.port, "/api/events", {
        Cookie: cookieOf(ctx.token),
        "Last-Event-ID": "1",
      });
      await sse.waitFor(1);
      await untilFrames(sse, (frames) => frames.filter(isDocChanged).length >= 1);
      sse.close();

      // 命中：不出现 reset，且补发/后续至少有一条 doc.changed 的 id > 1（中间可能混入 library.changed）。
      expect(sse.frames.some((frame) => frame.data.includes('"reset"'))).toBe(false);
      expect(sse.frames[0]?.id ?? -1).toBe(0);
      const changed = sse.frames.filter(isDocChanged);
      expect(changed.some((frame) => (frame.id ?? -1) > 1)).toBe(true);
    });
  });
});

describe("sse · Last-Event-ID 过期", () => {
  // 环容量 256（`createServerHub`）：推 258 条后 id=1 的补齐粒度已过期。
  it(
    "should send reset(events_expired) when the id fell out of the ring",
    { timeout: 90_000 },
    async () => {
      await withServer(async (ctx) => {
        for (let index = 0; index < 258; index += 1) {
          expect(await send(ctx.port, ctx.token, `<b>e${String(index)}</b>`)).toBe(200);
        }
        const sse = openSse(ctx.port, "/api/events", {
          Cookie: cookieOf(ctx.token),
          "Last-Event-ID": "1",
        });
        await sse.waitFor(2);
        const frames = sse.frames;
        sse.close();
        const reset = frames.find((frame) => frame.data.includes('"reset"'))?.data ?? "";

        expect(reset).toContain('"reason":"events_expired"');
      });
    },
  );
});

describe("sse · 连接上限", () => {
  it("should answer the 65th concurrent stream with 429 too_many_clients", async () => {
    await withServer(async (ctx) => {
      const sockets = await Promise.all(
        Array.from({ length: 64 }, async () => {
          const socket = connect({ host: "127.0.0.1", port: ctx.port });
          socket.setEncoding("utf8");
          socket.write(
            `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nAccept: text/event-stream\r\n\r\n`,
          );
          await new Promise((resolve) => socket.once("data", resolve));
          return socket;
        }),
      );
      const overflow = await httpCall(ctx.port, {
        path: "/api/events",
        headers: { cookie: cookieOf(ctx.token) },
      });
      for (const socket of sockets) socket.destroy();

      expect(overflow.status).toBe(429);
      expect(JSON.parse(overflow.body)).toMatchObject({ code: "too_many_clients" });
    });
  });

  it("should keep the client table clean after streams close", async () => {
    await withServer(async (ctx) => {
      const first = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await first.waitFor(1);
      first.close();
      const second = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      const frames = await second.waitFor(1);
      second.close();

      expect(frames).toHaveLength(1);
    });
  });
});
