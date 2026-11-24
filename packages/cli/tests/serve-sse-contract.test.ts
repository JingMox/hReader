// 这层管：**SSE 契约**——服务器真实帧 → 客户端真实解析器。
// 规矩：假件只能控时序，不能定义格式；帧格式必须与真服务器对一次。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodePatchDeps, nodeStyleDeps, startServer, type RunningServer } from "@hreader/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSse, type MessageEventLike, type SourceLike } from "../../app/src/sse";

const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><p data-hr-id="hr-b">一</p></article>',
  "</body></html>",
].join("\n");

interface Fixture {
  readonly workspace: string;
  readonly home: string;
  readonly server: RunningServer;
}

interface Frame {
  readonly event: string;
  readonly id: string;
  readonly data: string;
}

let fixture: Fixture | undefined;
let captured: Frame[] = [];

beforeAll(async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hr-sse-ws-"));
  const home = mkdtempSync(join(tmpdir(), "hr-sse-home-"));
  writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
  const server = await startServer(
    { workspace, port: 0, home, docId: "doc.html" },
    { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
  );
  fixture = { workspace, home, server };
  captured = await captureFrames(server, "二");
});

afterAll(async () => {
  if (fixture === undefined) return;
  await fixture.server.close();
  rmSync(fixture.workspace, { recursive: true, force: true });
  rmSync(fixture.home, { recursive: true, force: true });
});

const recordOf = (raw: string): Readonly<Record<string, unknown>> => {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`不是对象：${raw}`);
  }
  return { ...value };
};

/** 按 SSE 语法切帧：`event:` / `id:` / `data:` 三种行，空行结束（末尾帧也收）。 */
const framesOf = (text: string): Frame[] => {
  const frames: Frame[] = [];
  let event = "";
  let id = "";
  let data: string[] = [];
  const flush = (): void => {
    if (data.length > 0) {
      frames.push({ event: event === "" ? "message" : event, id, data: data.join("\n") });
    }
    event = "";
    id = "";
    data = [];
  };
  for (const line of text.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const sep = line.indexOf(":");
    const field = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? "" : line.slice(sep + 1).replace(/^ /u, "");
    if (field === "event") event = value;
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }
  flush();
  return frames;
};

/** 真长连接：读到 `until` 出现或到点 abort（用真连接的自然流，不轮询）。 */
const readStream = async (
  body: ReadableStream<Uint8Array>,
  until: string,
  deadlineMs: number,
  abort: () => void,
): Promise<string> => {
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timer = setTimeout(() => {
    abort();
  }, deadlineMs);
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      text += decoder.decode(step.value, { stream: true });
      if (text.includes(until)) break;
    }
  } catch {
    // abort 把流打断：已收到的字节仍然有效。
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
  return text;
};

const patchOnce = async (server: RunningServer, html: string): Promise<Response> =>
  await fetch(`http://127.0.0.1:${String(server.port)}/api/patch`, {
    method: "POST",
    headers: {
      cookie: `hr=${server.token}`,
      "content-type": "application/json",
      "x-hr-csrf": "1",
      host: `127.0.0.1:${String(server.port)}`,
    },
    body: JSON.stringify({
      docId: "doc.html",
      targetId: "hr-b",
      action: "replace",
      fragment: `<p data-hr-id="hr-b">${html}</p>`,
    }),
  });

/** 打开真 SSE 连接；`text` 读到目标帧或 3 s 到点。 */
const openEvents = async (
  server: RunningServer,
): Promise<{ text: (until: string) => Promise<string>; stop: () => void }> => {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${String(server.port)}/api/events`, {
    headers: { accept: "text/event-stream", cookie: `hr=${server.token}` },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const body = response.body;
  if (body === null) throw new Error("没有响应体");
  return {
    text: async (until) =>
      await readStream(body, until, 5000, () => {
        controller.abort();
      }),
    stop: () => {
      controller.abort();
    },
  };
};

/** 抓一组真帧：先像浏览器那样取一次 model（绑定 doc/revision），再真 patch，读到 `doc.changed`。 */
const captureFrames = async (server: RunningServer, html: string): Promise<Frame[]> => {
  const model = await fetch(`http://127.0.0.1:${String(server.port)}/api/doc/doc.html/model`, {
    headers: { cookie: `hr=${server.token}` },
  });
  expect(model.status).toBe(200);
  const events = await openEvents(server);
  const reading = events.text('"type":"doc.changed"');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const patched = await patchOnce(server, html);
  expect(patched.status).toBe(200);
  const frames = framesOf(await reading);
  events.stop();
  return frames;
};

const isDocChanged = (frame: Frame): boolean => recordOf(frame.data)["type"] === "doc.changed";

const expectedEventsOf = (frames: readonly Frame[]): { id: number; type: string }[] => {
  const events: { id: number; type: string }[] = [];
  for (const frame of frames) {
    const id = Number(frame.id);
    // 服务器把 `ready` 编成 id 0；客户端按"id 严格递增"把 0 当旧帧（设计如此）。
    if (id > 0) events.push({ id, type: String(recordOf(frame.data)["type"]) });
  }
  return events;
};

const assertTypedDocChanged = (frames: readonly Frame[]): void => {
  const changed = frames.filter(isDocChanged);
  expect(changed.length).toBeGreaterThan(0);
  const first = changed[0];
  expect(first?.id).toMatch(/^\d+$/u);
  expect(first?.event).toBe("message");
  const payload = recordOf(first?.data ?? "null");
  expect(payload["type"]).toBe("doc.changed");
  expect(Array.isArray(payload["changedNodes"])).toBe(true);
  expect(typeof payload["revision"]).toBe("string");
};

describe("SSE 契约 · 服务器帧 → 客户端解析器", () => {
  it("should produce frames that parse into typed doc.changed events", () => {
    assertTypedDocChanged(captured);
  });

  it("should feed those real frames into createSse and yield typed events", () => {
    const frames = captured;
    expect(frames.length).toBeGreaterThan(0);
    expect(replayThroughSse(frames)).toEqual(expectedEventsOf(frames));
  });

  it("should drop a replayed frame whose id the parser already saw (stale guard on real ids)", () => {
    const last = [...captured].reverse().find((frame) => Number(frame.id) > 0);
    if (last === undefined) throw new Error("fixture 没抓到 id>0 的帧");
    const expected = expectedEventsOf(captured);
    expect(expected.length).toBeGreaterThan(0);
    // 同一 id 再送一次：`isStale` 必须挡住，客户端事件序列与只送一遍完全相同。
    expect(replayThroughSse([...captured, last])).toEqual(expected);
  });

  it("should never leak an absolute path in a watcher-driven payload", async () => {
    // 实测：外部改工作区内非当前文档触发 `library.changed`，载荷必须只给相对路径，不泄绝对路径。
    const server = fixture?.server;
    if (server === undefined) throw new Error("fixture 未就绪");
    const events = await openEvents(server);
    const reading = events.text('"type":"library.changed"');
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(
      join(fixture?.workspace ?? "", "other.html"),
      DOC.replace("一", "外部改"),
      "utf8",
    );
    const text = await reading;
    events.stop();
    expect(text).toContain('"type":"library.changed"');
    expect(text).not.toContain(fixture?.workspace ?? "<none>");
  }, 15_000);
});

/** 只回放真帧；`lastEventId` 按帧头给（`main.ts` 的适配层正是在这里丢了 id）。 */
const replayThroughSse = (frames: readonly Frame[]): { id: number; type: string }[] => {
  const received: { id: number; type: string }[] = [];
  const listeners = new Map<string, (event: MessageEventLike) => void>();
  const source: SourceLike = {
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    close: () => undefined,
    setOpen: (listener) => {
      listener();
    },
    setError: () => undefined,
  };
  const sse = createSse(
    "/api/events",
    { open: () => source, schedule: () => () => undefined, random: () => 0.5 },
    {
      onEvent: (event) => {
        received.push({ id: event.id, type: event.type });
      },
      onState: () => undefined,
    },
  );
  sse.start();
  for (const frame of frames) {
    listeners.get(frame.event)?.({ data: frame.data, lastEventId: frame.id });
  }
  sse.close();
  return received;
};
