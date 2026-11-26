// This layer covers the **SSE contract** — real server frames → the real client parser.
// The rule: fakes may control timing, never define the format; the frame format must match the real server once.

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
    throw new Error(`not an object: ${raw}`);
  }
  return { ...value };
};

/** Split frames by SSE syntax: `event:` / `id:` / `data:` lines, ended by a blank line (a trailing frame counts). */
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

/** A real long connection: read until `until` appears or abort on time (use the natural flow of a real
 *  connection, no polling). Close with `releaseLock` rather than `cancel`: cancel kills the whole stream,
 *  and after the ready frame is consumed a later `text()` reads no bytes; releasing the lock lets the same
 *  body be read on in order. */
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
    // abort breaks the stream: bytes already received stay valid.
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
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

/** Open a real SSE connection and wait for the `ready` frame (the hub writes it only after registering the
 *  client) — returning only after ready guarantees a later patch lands on this stream; `text` reads until the target frame or a 5s deadline. */
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
  if (body === null) throw new Error("no response body");
  const text = async (until: string): Promise<string> =>
    await readStream(body, until, 5000, () => {
      controller.abort();
    });
  const opened = await text('"type":"ready"');
  expect(opened).toContain('"type":"ready"');
  return {
    text,
    stop: () => {
      controller.abort();
    },
  };
};

/** Capture a set of real frames: fetch model like a browser first (binding doc/revision), then really patch, and read until `doc.changed`. */
const captureFrames = async (server: RunningServer, html: string): Promise<Frame[]> => {
  const model = await fetch(`http://127.0.0.1:${String(server.port)}/api/doc/doc.html/model`, {
    headers: { cookie: `hr=${server.token}` },
  });
  expect(model.status).toBe(200);
  const events = await openEvents(server);
  const reading = events.text('"type":"doc.changed"');
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
    // The server emits `ready` as id 0; the client treats 0 as an old frame under "ids strictly increase" (by design).
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

describe("SSE contract · server frames → client parser", () => {
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
    if (last === undefined) throw new Error("fixture captured no id>0 frame");
    const expected = expectedEventsOf(captured);
    expect(expected.length).toBeGreaterThan(0);
    // Delivering the same id twice: `isStale` must block it, leaving the client event sequence identical to one delivery.
    expect(replayThroughSse([...captured, last])).toEqual(expected);
  });

  it("should emit library.changed with only the relative path when an outside change hits a non-current document", async () => {
    // Observed: an outside change to a non-current document in the workspace triggers `library.changed`; the payload must give only the relative path, never leak the absolute one.
    const server = fixture?.server;
    if (server === undefined) throw new Error("fixture not ready");
    const events = await openEvents(server);
    const reading = events.text('"type":"library.changed"');
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

/** Only real frames are replayed; `lastEventId` comes from the frame header (`main.ts`'s adapter lost the id right here). */
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
