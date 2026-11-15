// 这层管：真处理器（`handlersOf`）与会话收尾——`reset` 帧的降级提示、二次 `/hreader` 换订阅、
// `session_shutdown` 真停、垃圾帧不崩、`confirm` 抛错不外溢。

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

describe("事件流的降级提示", () => {
  it("`reset` 帧（环已过期）走到真处理器，notify 里点名 events_expired", async () => {
    const flow = flowOf({
      "/api/events": [{ chunks: ['data: {"type":"reset","reason":"events_expired"}\n\n'] }],
    });
    await flow.run(DOC_ID);
    await settleOf(16);
    const warnings = flow.context.notifies.filter((note) => note.type === "warning");
    expect(warnings.map((note) => note.message).join("\n")).toContain("events_expired");
  });

  it("垃圾帧：4 帧只报一条提示（节流），既不崩也不注入", async () => {
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
    // 逐个帧的“该不该算坏帧”由 `subscription.test.ts` 的四例表钉；这里钉的是节流形状：4 帧 → 1 条。
    expect(
      flow.context.notifies.filter((note) => note.message.includes("无法解析的事件帧")),
    ).toHaveLength(1);
  });
});

describe("断流截断", () => {
  it("断流截在 JSON 中间：残半帧静默丢弃，不报“疑似 core 协议漂移”的假警报", async () => {
    const flow = flowOf({ "/api/events": [{ chunks: ['id: 5\ndata: {"type":"doc.ch'] }] });
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(
      flow.context.notifies.filter((note) => note.message.includes("无法解析的事件帧")),
    ).toEqual([]);
  });
});

describe("末帧没有终止符", () => {
  it("流结束时末帧缺空行终止符，由 flush 交出（`doc.changed` 照样触发引流）", async () => {
    const flow = flowOf({
      "/api/events": [{ chunks: ['id: 9\ndata: {"type":"doc.changed","docId":"docs/a.html"}'] }],
      "/annotations": [{ text: '{"revision":1,"annotations":[]}' }],
    });
    await flow.run(DOC_ID);
    await settleOf(16);
    expect(flow.routed.calls.some((call) => call.url.endsWith("/annotations"))).toBe(true);
  });
});

describe("会话收尾", () => {
  it("同一会话再跑 `/hreader`：旧流被真关掉（`cancel` 落到旧 body 上，不出现两个连接并跑）", async () => {
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

  it("`session_shutdown` 真停订阅，且重复调用不抛（subscription 已清空）", async () => {
    const flow = flowOf({ "/api/events": [{ chunks: ["data: {}\n\n"], keepOpen: true }] });
    await flow.run(DOC_ID);
    await settleOf(8);
    expect(flow.fake.shutdown).toHaveLength(1);
    flow.fake.shutdown[0]?.();
    expect(() => flow.fake.shutdown[0]?.()).not.toThrow();
  });
});

describe("引流时的异常不外溢", () => {
  it("`confirm` 抛错：只 notify 一条 warning，不把异常抛回 Pi", async () => {
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

describe("事件与已绑定文档的关系", () => {
  it("别的文档的 `doc.changed` 不触发引流（按绑定的 docId 过滤）", async () => {
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

describe("引流的中途失败", () => {
  it("`doc.changed` 里没有 `docId`：不拉批注（`path` 是 doc.error 的字段）", async () => {
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

describe("引流时资源中途消失", () => {
  it("事件到达时 daemon.json 已消失：不拉批注、不注入", async () => {
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

  it("批注端点报错：不注入、不崩", async () => {
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

describe("引流时拿不到文档", () => {
  it("取不到 `/s/:docId`：注入文本照发，但明说读不到节点源码", async () => {
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

  it("节点已不在文档里：注入文本点明这一点", async () => {
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
