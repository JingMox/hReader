// 这层管：批注引流（AC-4）——`doc.changed` 只对**本会话绑定文档**触发、`anId` 进程内去重、
// `confirm=false` 后同一批注不再问、无 UI 模式只提示；全程走真扩展（命令 → 订阅 → 拉批注 → 注入）。

import { describe, expect, it } from "vitest";

import { hreaderExtensionOf } from "../pi-hreader.ts";
import { type ConfirmAnswer, daemonJsonOf, fakeContextOf, fakeDepsOf, fakePiOf } from "./fakes.ts";
import { routedFetchOf, settleOf, type ScriptedReply } from "./sse-fakes.ts";

const DAEMON = daemonJsonOf({ port: 7331, token: "tok-1", workspace: "/work" });
const DOC_ID = "docs/a.html";
const CHANGED = 'id: 7\ndata: {"type":"doc.changed","docId":"docs/a.html","revision":2}\n\n';
const OTHER_CHANGED = 'id: 8\ndata: {"type":"doc.changed","docId":"docs/b.html","revision":3}\n\n';
const DOC_ERROR = 'id: 9\ndata: {"type":"doc.error","path":"docs/a.html"}\n\n';
const HTML =
  '<article data-hr-id="root"><section data-hr-id="s1"><p data-hr-id="p1">原始正文</p></section>' +
  '<section data-hr-id="s2"><p data-hr-id="p2">第二段</p></section></article>';

const annotationOf = (id: string, nodeId: string, note: string, status = "pending_ai") => ({
  id,
  nodeId,
  note,
  status,
  createdAt: 1,
});

const annotationsOf = (items: readonly unknown[]): ScriptedReply => ({
  text: JSON.stringify({ revision: 2, annotations: items, lost: [], diagnostics: [] }),
});

interface Script {
  readonly events: readonly string[];
  readonly annotations: readonly ScriptedReply[];
  readonly document?: ScriptedReply;
}

const runOf = async (
  script: Script,
  options: { readonly hasUI?: boolean; readonly confirms?: readonly ConfirmAnswer[] } = {},
) => {
  const routed = routedFetchOf({
    "/api/events": [{ chunks: [script.events.join("")], keepOpen: true }],
    "/annotations": script.annotations,
    "/s/": [script.document ?? { text: HTML }],
  });
  const { deps } = fakeDepsOf({ home: "/home/u", daemon: DAEMON, fetch: routed.fetch });
  const fake = fakePiOf();
  hreaderExtensionOf(deps)(fake.pi);
  const context = fakeContextOf({
    hasUI: options.hasUI ?? true,
    confirms: options.confirms ?? [true, true, true],
  });
  const command = fake.commands.get("hreader");
  if (command === undefined) throw new Error("`/hreader` 没注册上");
  await command.handler(` ${DOC_ID} `, context.ctx);
  await settleOf(16);
  const annotationCalls = (): number =>
    routed.calls.filter((call) => call.url.endsWith("/annotations")).length;
  return { routed, fake, context, annotationCalls };
};

describe("批注引流", () => {
  it("绑定文档上的新批注：确认后把 节点源码 + 批注 + 路径 + nodeId 注入会话", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [annotationsOf([annotationOf("an-a", "p1", "把这段改短")])],
    });
    expect(context.confirms).toHaveLength(1);
    expect(fake.sentMessages).toHaveLength(1);
    const [message] = fake.sentMessages;
    expect(message?.customType).toBe("hreader.annotation");
    expect(message?.content).toContain(DOC_ID);
    expect(message?.content).toContain("p1");
    expect(message?.content).toContain('<p data-hr-id="p1">原始正文</p>');
    expect(message?.content).toContain("把这段改短");
  });

  it("同一 `anId` 来两次 `doc.changed`：只确认一次、只注入一次", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED + CHANGED],
      annotations: [annotationsOf([annotationOf("an-a", "p1", "改短")])],
    });
    expect(context.confirms).toHaveLength(1);
    expect(fake.sentMessages).toHaveLength(1);
  });
});

describe("批注引流的去重", () => {
  it("一次事件里的多条 pending 只拉一次 `/annotations`（请求数不随批注条数长）", async () => {
    const { fake, context, annotationCalls } = await runOf({
      events: [CHANGED],
      annotations: [
        annotationsOf([
          annotationOf("an-a", "p1", "第一条"),
          annotationOf("an-b", "p2", "第二条"),
          annotationOf("an-c", "p1", "第三条"),
        ]),
      ],
    });
    expect(annotationCalls()).toBe(1);
    expect(context.confirms).toHaveLength(3);
    expect(fake.sentMessages).toHaveLength(3);
  });
});

describe("批注引流的确认策略", () => {
  it("`confirm=false` 后同一 `anId` 不再问，但不拦后面的新批注", async () => {
    const { fake, context } = await runOf(
      {
        events: [CHANGED, CHANGED],
        annotations: [
          annotationsOf([annotationOf("an-a", "p1", "第一条")]),
          annotationsOf([
            annotationOf("an-a", "p1", "第一条"),
            annotationOf("an-b", "p2", "第二条"),
          ]),
        ],
      },
      { confirms: [false, true] },
    );
    expect(context.confirms).toHaveLength(2);
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.content).toContain("p2");
    expect(fake.sentMessages[0]?.content).toContain("第二条");
  });

  it("无 UI（print/json 模式）只通知、不确认、不注入", async () => {
    const { fake, context } = await runOf(
      {
        events: [CHANGED],
        annotations: [annotationsOf([annotationOf("an-a", "p1", "改短")])],
      },
      { hasUI: false, confirms: [] },
    );
    expect(context.confirms).toEqual([]);
    expect(fake.sentMessages).toEqual([]);
    expect(context.notifies.map((entry) => entry.message).join("\n")).toContain("改短");
  });
});

describe("批注引流的待处理状态口径（与 core 同：`pending_ai` + `pending`）", () => {
  it("阅读器新建的 `pending` 批注与旧版 `pending_ai` 批注都问、都注入", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [
        annotationsOf([
          annotationOf("an-new", "p1", "阅读器写的", "pending"),
          annotationOf("an-old", "p2", "旧版写的", "pending_ai"),
        ]),
      ],
    });
    expect(context.confirms).toHaveLength(2);
    expect(fake.sentMessages).toHaveLength(2);
    expect(fake.sentMessages[0]?.content).toContain("阅读器写的");
    expect(fake.sentMessages[1]?.content).toContain("旧版写的");
  });

  it("已解决/已拒绝/缺 `status`/非字符串 `status` 的批注不问", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [
        annotationsOf([
          annotationOf("an-a", "p1", "已完成", "resolved"),
          annotationOf("an-b", "p1", "已拒绝", "rejected"),
          { id: "an-c", nodeId: "p1", note: "没状态" },
          { id: "an-d", nodeId: "p1", note: "状态是数字", status: 1 },
        ]),
      ],
    });
    expect(context.confirms).toEqual([]);
    expect(fake.sentMessages).toEqual([]);
  });
});

describe("批注引流的过滤与认证", () => {
  it("已解决的批注（非 `pending_ai`/`pending`）不问", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [annotationsOf([annotationOf("an-a", "p1", "已完成", "resolved")])],
    });
    expect(context.confirms).toEqual([]);
    expect(fake.sentMessages).toEqual([]);
  });

  it("别的文档的 `doc.changed` 不触发拉批注", async () => {
    const { annotationCalls } = await runOf({
      events: [OTHER_CHANGED],
      annotations: [annotationsOf([])],
    });
    expect(annotationCalls()).toBe(0);
  });

  it("`doc.error` 不触发拉批注", async () => {
    const { annotationCalls } = await runOf({
      events: [DOC_ERROR],
      annotations: [annotationsOf([])],
    });
    expect(annotationCalls()).toBe(0);
  });

  it("拉批注带 cookie 认证（值就是 token）", async () => {
    const { routed } = await runOf({ events: [CHANGED], annotations: [annotationsOf([])] });
    const call = routed.calls.find((entry) => entry.url.endsWith("/annotations"));
    expect(call?.url).toBe("http://127.0.0.1:7331/api/doc/docs%2Fa.html/annotations");
    expect(call?.request.headers["cookie"]).toBe("hr=tok-1");
  });
});
