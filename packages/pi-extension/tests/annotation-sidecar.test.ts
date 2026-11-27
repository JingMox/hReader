// Sidecar merge into the pending-annotation push: `doc.annotations` (the sidecar write routes'
// own event) also triggers intake, `GET /api/doc/:docId/sidecar` merges its `source:"sidecar"`
// entries deduped by id with meta winning, and a daemon without the route degrades to meta-only.

import { describe, expect, it } from "vitest";

import { hreaderExtensionOf } from "../pi-hreader.ts";
import { type ConfirmAnswer, daemonJsonOf, fakeContextOf, fakeDepsOf, fakePiOf } from "./fakes.ts";
import { routedFetchOf, settleOf, type ScriptedReply } from "./sse-fakes.ts";

const DAEMON = daemonJsonOf({ port: 7331, token: "tok-1", workspace: "/work" });
const DOC_ID = "docs/a.html";
const CHANGED = 'id: 7\ndata: {"type":"doc.changed","docId":"docs/a.html","revision":2}\n\n';
const ANNOTATED = 'id: 9\ndata: {"type":"doc.annotations","docId":"docs/a.html"}\n\n';
const OTHER_ANNOTATED = 'id: 10\ndata: {"type":"doc.annotations","docId":"docs/b.html"}\n\n';
const HTML =
  '<article data-hr-id="root"><section data-hr-id="s1"><p data-hr-id="p1">原始正文</p></section>' +
  '<section data-hr-id="s2"><p data-hr-id="p2">第二段</p></section></article>';

const metaAnnotationOf = (id: string, nodeId: string, note: string, status = "pending") => ({
  id,
  nodeId,
  note,
  status,
  createdAt: 1,
});

const annotationsReplyOf = (items: readonly unknown[]): ScriptedReply => ({
  text: JSON.stringify({ revision: 2, annotations: items, lost: [], diagnostics: [] }),
});

const sidecarEntryOf = (patch: Record<string, unknown>): Record<string, unknown> => ({
  id: "an-s",
  selector: "body > p:nth-of-type(1)",
  anchor: { exact: "原始正文", prefix: "", suffix: "", start: 0 },
  note: "侧车来的",
  status: "pending",
  author: "user",
  replies: [],
  source: "sidecar",
  relocation: { ok: true, start: 0, end: 4, via: "selector" },
  ...patch,
});

const sidecarReplyOf = (items: readonly unknown[]): ScriptedReply => ({
  text: JSON.stringify({ annotations: items, diagnostics: [] }),
});

interface Script {
  readonly events: readonly string[];
  readonly annotations: readonly ScriptedReply[];
  readonly sidecar?: readonly ScriptedReply[];
  readonly document?: ScriptedReply;
}

const runOf = async (
  script: Script,
  options: { readonly hasUI?: boolean; readonly confirms?: readonly ConfirmAnswer[] } = {},
) => {
  const routes: Record<string, readonly ScriptedReply[]> = {
    "/api/events": [{ chunks: [script.events.join("")], keepOpen: true }],
    "/annotations": script.annotations,
    "/s/": [script.document ?? { text: HTML }],
  };
  if (script.sidecar !== undefined) routes["/sidecar"] = script.sidecar;
  const routed = routedFetchOf(routes);
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
  const callsTo = (needle: string): number =>
    routed.calls.filter((call) => call.url.includes(needle)).length;
  return { routed, fake, context, callsTo };
};

describe("sidecar merge into the pending push", () => {
  it("should merge pending sidecar entries into a doc.changed-triggered push", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([metaAnnotationOf("an-m", "p1", "meta 批注")])],
      sidecar: [sidecarReplyOf([sidecarEntryOf({ id: "an-s", nodeId: "p2" })])],
    });
    expect(context.confirms).toHaveLength(2);
    expect(fake.sentMessages).toHaveLength(2);
    expect(fake.sentMessages[0]?.content).toContain("meta 批注");
    expect(fake.sentMessages[1]?.content).toContain("侧车来的");
    expect(fake.sentMessages[1]?.content).toContain("p2");
  });

  it("should let meta win an id collision: the sidecar twin never asks", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([metaAnnotationOf("an-1", "p1", "meta 版本")])],
      sidecar: [sidecarReplyOf([sidecarEntryOf({ id: "an-1", note: "侧车版本" })])],
    });
    expect(context.confirms).toHaveLength(1);
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.content).toContain("meta 版本");
    expect(fake.sentMessages[0]?.content).not.toContain("侧车版本");
  });

  it("should fire intake on doc.annotations, the sidecar write routes' own event", async () => {
    const { fake, context, callsTo } = await runOf({
      events: [ANNOTATED],
      annotations: [annotationsReplyOf([])],
      sidecar: [sidecarReplyOf([sidecarEntryOf({ id: "an-s", nodeId: "p1" })])],
    });
    expect(callsTo("/sidecar")).toBeGreaterThan(0);
    expect(context.confirms).toHaveLength(1);
    expect(fake.sentMessages[0]?.content).toContain("侧车来的");
  });

  it("should not fetch anything for another document's doc.annotations", async () => {
    const { callsTo } = await runOf({
      events: [OTHER_ANNOTATED],
      annotations: [annotationsReplyOf([])],
      sidecar: [sidecarReplyOf([sidecarEntryOf({})])],
    });
    expect(callsTo("/annotations")).toBe(0);
    expect(callsTo("/sidecar")).toBe(0);
  });

  it("should fall back to the selector as the injection anchor when a sidecar entry has no nodeId", async () => {
    const { fake } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([])],
      sidecar: [sidecarReplyOf([sidecarEntryOf({ id: "an-s" })])],
    });
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.content).toContain("body > p:nth-of-type(1)");
    expect(fake.sentMessages[0]?.content).toContain("（批注没有节点锚点，按摘录位置处理）");
  });

  it("should name the node in the injection header for a meta push, exactly as before sidecar", async () => {
    const { fake } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([metaAnnotationOf("an-m", "p1", "meta 批注")])],
    });
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.content).toContain("（文档 docs/a.html，节点 p1）");
    expect(fake.sentMessages[0]?.content).not.toContain("锚点");
  });

  it("should name the node for a sidecar entry that carries a nodeId, and the anchor only without one", async () => {
    const { fake } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([])],
      sidecar: [
        sidecarReplyOf([
          sidecarEntryOf({ id: "an-sel" }),
          sidecarEntryOf({ id: "an-node", nodeId: "p2" }),
        ]),
      ],
    });
    expect(fake.sentMessages).toHaveLength(2);
    expect(fake.sentMessages[0]?.content).toContain("（文档 docs/a.html，锚点 body > p:nth-of-type(1)）");
    expect(fake.sentMessages[0]?.content).not.toContain("，节点");
    expect(fake.sentMessages[1]?.content).toContain("（文档 docs/a.html，节点 p2）");
  });

  it("should fall back to the anchored excerpt then the id when neither nodeId nor selector is present", async () => {
    const { fake } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([])],
      sidecar: [
        sidecarReplyOf([
          sidecarEntryOf({ id: "an-exact", selector: undefined }),
          sidecarEntryOf({ id: "an-bare", selector: undefined, anchor: "not-a-record" }),
        ]),
      ],
    });
    expect(fake.sentMessages).toHaveLength(2);
    expect(fake.sentMessages[0]?.content).toContain("原始正文");
    expect(fake.sentMessages[1]?.content).toContain("an-bare");
  });

  it("should keep the meta push working when the sidecar route does not exist (degrades silently)", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([metaAnnotationOf("an-m", "p1", "meta 批注")])],
    });
    expect(context.confirms).toHaveLength(1);
    expect(fake.sentMessages[0]?.content).toContain("meta 批注");
  });

  it("should still push a sidecar entry that carries no note text", async () => {
    const { fake } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([])],
      sidecar: [
        sidecarReplyOf([sidecarEntryOf({ id: "an-quiet", nodeId: "p1", note: undefined })]),
      ],
    });
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.content).toContain("锚点 p1");
  });

  it("should keep the meta push working when the sidecar reply has no annotations array", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([metaAnnotationOf("an-m", "p1", "meta 批注")])],
      sidecar: [{ text: JSON.stringify({ diagnostics: [] }) }],
    });
    expect(context.confirms).toHaveLength(1);
    expect(fake.sentMessages[0]?.content).toContain("meta 批注");
  });

  it("should keep the meta push working when the sidecar read fails", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([metaAnnotationOf("an-m", "p1", "meta 批注")])],
      sidecar: [{ status: 500, text: '{"code":"internal","message":"boom"}' }],
    });
    expect(context.confirms).toHaveLength(1);
    expect(fake.sentMessages[0]?.content).toContain("meta 批注");
  });

  it("should ignore sidecar entries that are resolved, meta-sourced, or id-less", async () => {
    const { fake, context } = await runOf({
      events: [CHANGED],
      annotations: [annotationsReplyOf([])],
      sidecar: [
        sidecarReplyOf([
          sidecarEntryOf({ id: "an-r", status: "resolved" }),
          sidecarEntryOf({ id: "an-m", source: "meta", nodeId: "p1" }),
          { selector: "x", note: "没 id", status: "pending", source: "sidecar" },
        ]),
      ],
    });
    expect(context.confirms).toEqual([]);
    expect(fake.sentMessages).toEqual([]);
  });
});
