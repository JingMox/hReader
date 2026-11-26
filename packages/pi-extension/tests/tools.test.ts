// Contracts of the three tools: names / param schemas / the success shape `{ content, details.revision }`,
// never throwing bare on failure (error codes come from the daemon), `delete` sending no fragment, and
// out-of-bounds paths rejected before any param validation.

import { describe, expect, it } from "vitest";

import { hreaderExtensionOf, PATCH_ACTIONS, type HreaderToolResult } from "../pi-hreader.ts";
import { callToolOf, daemonJsonOf, fakeContextOf, fakeDepsOf, fakePiOf } from "./fakes.ts";
import { routedFetchOf, type ScriptedReply } from "./sse-fakes.ts";

const DAEMON = daemonJsonOf({ port: 7331, token: "tok-1", workspace: "/work" });
const HTML =
  '<article data-hr-id="root"><section data-hr-id="s1"><p data-hr-id="p1">原始正文</p>' +
  '<p data-hr-id="p2">第二段</p></section></article>';
const ANNOTATIONS = JSON.stringify({
  revision: 2,
  annotations: [
    { id: "an-a", nodeId: "p1", note: "改短", status: "pending_ai" },
    { id: "an-b", nodeId: "p1", note: "已完成", status: "resolved" },
    { id: "an-c", nodeId: "s1", note: "别的节点", status: "pending_ai" },
  ],
  lost: [],
  diagnostics: [],
});

interface Harness {
  readonly run: (
    name: string,
    params: Readonly<Record<string, unknown>>,
  ) => Promise<HreaderToolResult>;
  readonly calls: readonly {
    url: string;
    request: { readonly body?: string; readonly headers: Readonly<Record<string, string>> };
  }[];
  readonly tools: ReadonlyMap<string, { readonly parameters: unknown }>;
}

const harnessOf = (
  routes: Readonly<Record<string, readonly ScriptedReply[]>>,
  options: { readonly withDaemon?: boolean } = {},
): Harness => {
  const daemon = options.withDaemon === false ? undefined : DAEMON;
  const routed = routedFetchOf(routes);
  const { deps } = fakeDepsOf({
    home: "/home/u",
    fetch: routed.fetch,
    ...(daemon === undefined ? {} : { daemon }),
  });
  const fake = fakePiOf();
  hreaderExtensionOf(deps)(fake.pi);
  const ctx = fakeContextOf().ctx;
  return {
    run: (name, params) => callToolOf(fake, name, params, ctx),
    calls: routed.calls,
    tools: fake.tools,
  };
};

const textOf = (result: HreaderToolResult): string => result.content[0]?.text ?? "";

describe("tool registration surface", () => {
  it("should give all three tools TypeBox object param schemas (counted one by one, not just `patch_node`)", () => {
    const { tools } = harnessOf({});
    expect([...tools.keys()]).toEqual([
      "hreader_outline",
      "hreader_read_node",
      "hreader_patch_node",
    ]);
    for (const [name, tool] of tools) {
      expect(tool.parameters, name).toMatchObject({ type: "object" });
    }
    expect(PATCH_ACTIONS).toEqual(["replace", "insert_before", "insert_after", "append", "delete"]);
  });
});

describe("hreader_outline", () => {
  it("should GET `/api/doc/<docId>/outline` and carry the daemon's revision", async () => {
    const harness = harnessOf({
      "/outline": [{ text: JSON.stringify({ revision: 3, outline: { wordCount: 12 } }) }],
    });
    const result = await harness.run("hreader_outline", { path: "docs/a.html" });
    expect(harness.calls[0]?.url).toBe("http://127.0.0.1:7331/api/doc/docs%2Fa.html/outline");
    expect(harness.calls[0]?.request.headers["cookie"]).toBe("hr=tok-1");
    expect(result.details).toMatchObject({ revision: 3, docId: "docs/a.html" });
    expect(textOf(result)).toContain('"wordCount": 12');
  });
});

describe("hreader_outline failure paths (none may throw bare)", () => {
  it("should return a text hint and send no request when the daemon is down (never spawns)", async () => {
    const harness = harnessOf({}, { withDaemon: false });
    const result = await harness.run("hreader_outline", { path: "docs/a.html" });
    expect(harness.calls).toEqual([]);
    expect(textOf(result)).toContain("hr serve");
  });

  it("should return `path_outside_workspace` and send no request for an out-of-bounds path", async () => {
    const harness = harnessOf({});
    const result = await harness.run("hreader_outline", { path: "/etc/passwd" });
    expect(harness.calls).toEqual([]);
    expect(textOf(result)).toContain("path_outside_workspace");
  });

  it("should carry the error code in text without throwing when the daemon errors", async () => {
    const harness = harnessOf({
      "/outline": [{ status: 404, text: '{"code":"not_found","message":"没有这个文档"}' }],
    });
    const result = await harness.run("hreader_outline", { path: "docs/a.html" });
    expect(textOf(result)).toContain("[not_found]");
    expect(textOf(result)).toContain("没有这个文档");
  });
});

describe("hreader_outline transport failures", () => {
  it("should also degrade a non-JSON server error to text (`http_<status>`)", async () => {
    const harness = harnessOf({ "/outline": [{ status: 502, text: "<html>bad gateway" }] });
    const result = await harness.run("hreader_outline", { path: "docs/a.html" });
    expect(textOf(result)).toContain("daemon 返回 502");
  });

  it("should return io_failure text when the daemon is unreachable (fetch throws)", async () => {
    const { deps } = fakeDepsOf({
      home: "/home/u",
      daemon: DAEMON,
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const fake = fakePiOf();
    hreaderExtensionOf(deps)(fake.pi);
    const result = await callToolOf(fake, "hreader_outline", { path: "a.md" }, fakeContextOf().ctx);
    expect(textOf(result)).toContain("[io_failure]");
  });
});

describe("hreader_read_node", () => {
  it("should fetch node HTML (node source comes from `/s/:docId` source bytes) and attach only that node's pending annotations", async () => {
    const harness = harnessOf({
      "/s/": [{ text: HTML }],
      "/annotations": [{ text: ANNOTATIONS }],
    });
    const result = await harness.run("hreader_read_node", {
      path: "docs/a.html",
      nodeId: "p1",
    });
    const text = textOf(result);
    expect(text).toContain('"docId": "docs/a.html"');
    expect(text).toContain('"nodeId": "p1"');
    // Quotes inside JSON text get escaped, so assert on content: p1's own source was sliced, siblings left out.
    expect(text).toContain("原始正文");
    expect(text).not.toContain("第二段");
    // Only pending annotations on this node are attached: `an-b` is resolved, `an-c` belongs to another node.
    expect(text).toContain("an-a");
    expect(text).not.toContain("an-b");
    expect(text).not.toContain("an-c");
  });

  it("should return node_not_found text for a missing node", async () => {
    const harness = harnessOf({ "/s/": [{ text: HTML }], "/annotations": [{ text: ANNOTATIONS }] });
    const result = await harness.run("hreader_read_node", {
      path: "docs/a.html",
      nodeId: "nope",
    });
    expect(textOf(result)).toContain("[node_not_found]");
  });

  it("should return io_failure text when the document source cannot be fetched", async () => {
    const harness = harnessOf({ "/s/": [{ status: 404, text: "" }] });
    const result = await harness.run("hreader_read_node", {
      path: "docs/a.html",
      nodeId: "p1",
    });
    expect(textOf(result)).toContain("[io_failure]");
  });
});

describe("hreader_patch_node", () => {
  it("should POST `/api/patch` with core's field names `targetId`/`fragment` and the CSRF header", async () => {
    const harness = harnessOf({ "/api/patch": [{ text: '{"changed":true,"revision":4}' }] });
    const result = await harness.run("hreader_patch_node", {
      path: "docs/a.html",
      nodeId: "p1",
      action: "replace",
      htmlContent: "<p>新的</p>",
    });
    const call = harness.calls[0];
    expect(call?.url).toBe("http://127.0.0.1:7331/api/patch");
    expect(call?.request.headers["x-hr-csrf"]).toBe("1");
    expect(JSON.parse(call?.request.body ?? "{}")).toEqual({
      docId: "docs/a.html",
      targetId: "p1",
      action: "replace",
      fragment: "<p>新的</p>",
    });
    expect(result.details).toMatchObject({ revision: 4, changed: true });
  });
});

describe("hreader_patch_node write shape", () => {
  it("should send no fragment for `delete` (same fork as MCP's requestOf)", async () => {
    const harness = harnessOf({ "/api/patch": [{ text: '{"changed":true,"revision":5}' }] });
    await harness.run("hreader_patch_node", {
      path: "docs/a.html",
      nodeId: "p1",
      action: "delete",
      htmlContent: "",
    });
    expect(JSON.parse(harness.calls[0]?.request.body ?? "{}")).toEqual({
      docId: "docs/a.html",
      targetId: "p1",
      action: "delete",
    });
  });

  it("should carry the error code in text without throwing when the daemon refuses", async () => {
    const harness = harnessOf({
      "/api/patch": [{ status: 409, text: '{"code":"busy","message":"文档正被占用"}' }],
    });
    const result = await harness.run("hreader_patch_node", {
      path: "docs/a.html",
      nodeId: "p1",
      action: "replace",
      htmlContent: "<p>x</p>",
    });
    expect(textOf(result)).toContain("[busy]");
  });
});
