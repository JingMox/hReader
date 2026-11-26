// Real handlers (`handlersOf`) and session teardown: the `reset` frame's staleness notice, a second
// `/hreader` swapping the subscription, `session_shutdown` really stopping, junk frames not crashing,
// and `confirm` failures not leaking.

import { describe, expect, it } from "vitest";

import { hreaderExtensionOf, type DaemonInfo } from "../pi-hreader.ts";
import {
  type ConfirmAnswer,
  daemonJsonOf,
  fakeContextOf,
  fakeDepsOf,
  fakePiOf,
  fakeReadFileOf,
  runCommandOf,
} from "./fakes.ts";
import { holdDelayOf, routedFetchOf, settleOf, type ScriptedReply } from "./sse-fakes.ts";

const DAEMON: DaemonInfo = { port: 7331, token: "tok-1", pid: 4242, workspace: "/work" };
const DAEMON_JSON = daemonJsonOf({ port: DAEMON.port, token: DAEMON.token, workspace: "/work" });
const DOC_ID = "docs/a.html";
const CHANGED = 'id: 7\ndata: {"type":"doc.changed","docId":"docs/a.html"}\n\n';

const flowOf = (
  routes: Readonly<Record<string, readonly ScriptedReply[]>>,
  confirms: readonly ConfirmAnswer[] = [true],
) => {
  const routed = routedFetchOf(routes);
  const { deps } = fakeDepsOf({ home: "/home/u", daemon: DAEMON_JSON, fetch: routed.fetch });
  const fake = fakePiOf();
  hreaderExtensionOf({ ...deps, delay: holdDelayOf() })(fake.pi);
  const context = fakeContextOf({ confirms });
  return {
    routed,
    fake,
    context,
    run: (args: string) => runCommandOf(fake, "hreader", args, context.ctx),
  };
};

const DAEMON_PATH = "/home/u/.hreader/daemon.json";
const PENDING =
  '{"revision":1,"annotations":[{"id":"an-a","nodeId":"p1","note":"改短","status":"pending_ai"}]}';
const flowWithFilesOf = (
  routes: Readonly<Record<string, readonly ScriptedReply[]>>,
  files: Record<string, string>,
) => {
  const routed = routedFetchOf(routes);
  const { deps } = fakeDepsOf({ home: "/home/u", fetch: routed.fetch });
  const fake = fakePiOf();
  hreaderExtensionOf({ ...deps, readFile: fakeReadFileOf(files), delay: holdDelayOf() })(fake.pi);
  const context = fakeContextOf({ confirms: [true] });
  return {
    routed,
    fake,
    context,
    run: (args: string) => runCommandOf(fake, "hreader", args, context.ctx),
    annotationCalls: () => routed.calls.filter((call) => call.url.endsWith("/annotations")),
  };
};

describe("event-stream staleness notice", () => {
  it("should route a `reset` frame (ring expired) to the real handler and name events_expired in the notify", async () => {
    const flow = flowOf({
      "/api/events": [{ chunks: ['data: {"type":"reset","reason":"events_expired"}\n\n'] }],
    });
    await flow.run(DOC_ID);
    await settleOf(16);
    const warnings = flow.context.notifies.filter((note) => note.type === "warning");
    expect(warnings.map((note) => note.message).join("\n")).toContain("events_expired");
  });

  it("should report only one hint for 4 junk frames (throttled), neither crashing nor injecting", async () => {
    const flow = flowOf({
      "/api/events": [
        {
          chunks: [
            "data: 不是 JSON\n\n" +
              'data: {"no":"type"}\n\n' +
              "data: 123\n\n" +
              'data: {"type":"applause"}\n\n',
          ],
        },
      ],
    });
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(flow.fake.sentMessages).toEqual([]);
    // Per-frame "is it bad" is pinned by `subscription.test.ts`'s four-case table; pinned here is the throttle shape: 4 frames → 1 report.
    expect(
      flow.context.notifies.filter((note) => note.message.includes("无法解析的事件帧")),
    ).toHaveLength(1);
  });
});

describe("mid-stream truncation", () => {
  it('should silently drop a half frame cut mid-JSON without raising a false "possible core protocol drift" alarm', async () => {
    const flow = flowOf({ "/api/events": [{ chunks: ['id: 5\ndata: {"type":"doc.ch'] }] });
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(
      flow.context.notifies.filter((note) => note.message.includes("无法解析的事件帧")),
    ).toEqual([]);
  });
});

describe("final frame without terminator", () => {
  it("should flush the final frame lacking its blank-line terminator (`doc.changed` still triggers the intake)", async () => {
    const flow = flowOf({
      "/api/events": [{ chunks: ['id: 9\ndata: {"type":"doc.changed","docId":"docs/a.html"}'] }],
      "/annotations": [{ text: '{"revision":1,"annotations":[]}' }],
    });
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(flow.routed.calls.some((call) => call.url.endsWith("/annotations"))).toBe(true);
  });
});

describe("session teardown", () => {
  it("should really close the old stream on a second `/hreader` in one session (`cancel` lands on the old body; no two connections in flight)", async () => {
    let oldCancels = 0;
    const flow = flowOf({
      "/api/events": [
        {
          chunks: ['retry: 2000\nid: 0\ndata: {"type":"ready"}\n\n'],
          keepOpen: true,
          onCancel: () => {
            oldCancels += 1;
          },
        },
        { chunks: ['retry: 2000\nid: 0\ndata: {"type":"ready"}\n\n'], keepOpen: true },
      ],
    });
    await flow.run(DOC_ID);
    await flow.run(DOC_ID);
    await settleOf(16);
    const connections = flow.routed.calls.filter((call) => call.url.endsWith("/api/events"));
    expect(connections).toHaveLength(2);
    expect(oldCancels).toBe(1);
  });

  it("should really stop the subscription on `session_shutdown` and not throw when called twice (subscription already cleared)", async () => {
    const flow = flowOf({ "/api/events": [{ chunks: ["data: {}\n\n"], keepOpen: true }] });
    await flow.run(DOC_ID);
    await settleOf(8);
    expect(flow.fake.shutdown).toHaveLength(1);
    flow.fake.shutdown[0]?.();
    expect(() => flow.fake.shutdown[0]?.()).not.toThrow();
  });
});

describe("intake errors do not escape", () => {
  it("should emit only one warning notify on a `confirm` throw without throwing back at Pi", async () => {
    const flow = flowOf(
      {
        "/api/events": [{ chunks: [CHANGED] }],
        "/annotations": [
          {
            text: '{"revision":1,"annotations":[{"id":"an-a","nodeId":"p1","note":"x","status":"pending_ai"}]}',
          },
        ],
        "/s/": [{ text: '<article data-hr-id="root"><p data-hr-id="p1">正文</p></article>' }],
      },
      ["throw"],
    );
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(flow.fake.sentMessages).toEqual([]);
    expect(
      flow.context.notifies.some((note) => note.message.includes("处理 hReader 批注事件时出错")),
    ).toBe(true);
  });
});

describe("events vs the bound document", () => {
  it("should not trigger intake for another document's `doc.changed` (filtered by the bound docId)", async () => {
    const flow = flowWithFilesOf(
      {
        "/api/events": [
          { chunks: ['id: 7\ndata: {"type":"doc.changed","docId":"docs/b.html"}\n\n'] },
        ],
        "/annotations": [{ text: PENDING }],
      },
      { [DAEMON_PATH]: DAEMON_JSON },
    );
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(flow.annotationCalls()).toEqual([]);
    expect(flow.fake.sentMessages).toEqual([]);
  });
});

describe("mid-intake failures", () => {
  it("should not fetch annotations when `doc.changed` lacks `docId` (`path` is a doc.error field)", async () => {
    const flow = flowWithFilesOf(
      {
        "/api/events": [
          { chunks: ['id: 7\ndata: {"type":"doc.changed","path":"docs/a.html"}\n\n'] },
        ],
        "/annotations": [{ text: PENDING }],
      },
      { [DAEMON_PATH]: DAEMON_JSON },
    );
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(flow.annotationCalls()).toEqual([]);
  });
});

describe("resources disappearing mid-intake", () => {
  it("should neither fetch annotations nor inject when daemon.json is gone by the time the event arrives", async () => {
    const files: Record<string, string> = { [DAEMON_PATH]: DAEMON_JSON };
    const flow = flowWithFilesOf(
      { "/api/events": [{ chunks: [CHANGED] }], "/annotations": [{ text: PENDING }] },
      files,
    );
    await flow.run(DOC_ID);
    Reflect.deleteProperty(files, DAEMON_PATH);
    await settleOf(16);
    expect(flow.annotationCalls()).toEqual([]);
    expect(flow.fake.sentMessages).toEqual([]);
  });

  it("should neither inject nor crash when the annotation endpoint errors", async () => {
    const flow = flowWithFilesOf(
      {
        "/api/events": [{ chunks: [CHANGED] }],
        "/annotations": [{ status: 500, text: '{"code":"io_failure"}' }],
      },
      { [DAEMON_PATH]: DAEMON_JSON },
    );
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(flow.fake.sentMessages).toEqual([]);
  });
});

describe("document unavailable during intake", () => {
  it("should still send the injected text when `/s/:docId` cannot be fetched, stating node source is unreadable", async () => {
    const flow = flowWithFilesOf(
      {
        "/api/events": [{ chunks: [CHANGED] }],
        "/annotations": [{ text: PENDING }],
        "/s/": [{ status: 500, text: "" }],
      },
      { [DAEMON_PATH]: DAEMON_JSON },
    );
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(flow.fake.sentMessages[0]?.content).toContain("（读不到节点源码）");
  });

  it("should state in the injected text that the node is no longer in the document", async () => {
    const flow = flowWithFilesOf(
      {
        "/api/events": [{ chunks: [CHANGED] }],
        "/annotations": [{ text: PENDING }],
        "/s/": [{ text: '<article data-hr-id="root"><p data-hr-id="p9">别的</p></article>' }],
      },
      { [DAEMON_PATH]: DAEMON_JSON },
    );
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(flow.fake.sentMessages[0]?.content).toContain("（该节点已不在文档里）");
  });
});
