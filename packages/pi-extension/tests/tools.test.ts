// 这层管：三个工具的契约——名字/参数 schema/成功形状 `{ content, details.revision }`、
// 失败不抛裸异常（错误码来自 daemon）、`delete` 不发片段、参数校验前就挡掉越界路径。

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

describe("工具注册面", () => {
  it("三个工具的参数 schema 都是 TypeBox 对象（逐个数，不只 `patch_node`）", () => {
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
  it("GET `/api/doc/<docId>/outline`，带上 daemon 的 revision", async () => {
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

describe("hreader_outline 的失败路径（都不许抛裸异常）", () => {
  it("daemon 没起：返回文本提示，不发请求（绝不 spawn）", async () => {
    const harness = harnessOf({}, { withDaemon: false });
    const result = await harness.run("hreader_outline", { path: "docs/a.html" });
    expect(harness.calls).toEqual([]);
    expect(textOf(result)).toContain("hr serve");
  });

  it("路径越界：返回 `path_outside_workspace`，不发请求", async () => {
    const harness = harnessOf({});
    const result = await harness.run("hreader_outline", { path: "/etc/passwd" });
    expect(harness.calls).toEqual([]);
    expect(textOf(result)).toContain("path_outside_workspace");
  });

  it("daemon 报错：文本里带错误码，不抛异常", async () => {
    const harness = harnessOf({
      "/outline": [{ status: 404, text: '{"code":"not_found","message":"没有这个文档"}' }],
    });
    const result = await harness.run("hreader_outline", { path: "docs/a.html" });
    expect(textOf(result)).toContain("[not_found]");
    expect(textOf(result)).toContain("没有这个文档");
  });
});

describe("hreader_outline 的传输失败", () => {
  it("非 JSON 的服务端错误也降级成文本（`http_<status>`）", async () => {
    const harness = harnessOf({ "/outline": [{ status: 502, text: "<html>bad gateway" }] });
    const result = await harness.run("hreader_outline", { path: "docs/a.html" });
    expect(textOf(result)).toContain("daemon 返回 502");
  });

  it("连不上 daemon（fetch 抛错）→ io_failure 文本", async () => {
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
  it("取节点 HTML（节点源码来自 `/s/:docId` 的源文件字节），只附该节点未处理的批注", async () => {
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
    // JSON 文本里的引号会被转义，所以按"内容"断言：切到了 p1 自己的源码，且没带上兄弟节点。
    expect(text).toContain("原始正文");
    expect(text).not.toContain("第二段");
    // 只附该节点上的 pending 批注：`an-b` 已解决、`an-c` 属于别的节点。
    expect(text).toContain("an-a");
    expect(text).not.toContain("an-b");
    expect(text).not.toContain("an-c");
  });

  it("节点不存在：`node_not_found` 文本", async () => {
    const harness = harnessOf({ "/s/": [{ text: HTML }], "/annotations": [{ text: ANNOTATIONS }] });
    const result = await harness.run("hreader_read_node", {
      path: "docs/a.html",
      nodeId: "nope",
    });
    expect(textOf(result)).toContain("[node_not_found]");
  });

  it("取不到文档源码：`io_failure` 文本", async () => {
    const harness = harnessOf({ "/s/": [{ status: 404, text: "" }] });
    const result = await harness.run("hreader_read_node", {
      path: "docs/a.html",
      nodeId: "p1",
    });
    expect(textOf(result)).toContain("[io_failure]");
  });
});

describe("hreader_patch_node", () => {
  it("POST `/api/patch`，body 用 core 的字段名 `targetId`/`fragment`，带 CSRF 头", async () => {
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

describe("hreader_patch_node 的写盘形状", () => {
  it("`delete` 不发片段（同 MCP 侧 requestOf 的分叉）", async () => {
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

  it("daemon 拒绝：文本带错误码，不抛异常", async () => {
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
