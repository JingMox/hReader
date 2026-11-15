// 这层管：纯函数层的边角与工具的失败缝——缺参拼路径、错误码文案的细节分叉、节点切片的坏输入、
// 解码器溢出、`/s/:docId` 取不到、批注负载形状不对。每个"防御分支"都要有一个真能跑到的输入。

import { describe, expect, it } from "vitest";

import {
  createSseDecoder,
  ENDPOINTS,
  errorTextOf,
  hreaderExtensionOf,
  nodeSliceOf,
  pathOf,
} from "../pi-hreader.ts";
import { callToolOf, daemonJsonOf, fakeContextOf, fakeDepsOf, fakePiOf } from "./fakes.ts";
import { routedFetchOf } from "./sse-fakes.ts";

const DAEMON = daemonJsonOf({ port: 7331, token: "tok-1", workspace: "/work" });

describe("pathOf 的缺参兜底", () => {
  it("占位符没给值 → 编成空段，不抛", () => {
    expect(pathOf(ENDPOINTS.outline)).toBe("/api/doc//outline");
  });
});

describe("errorTextOf 的文案分叉", () => {
  it("没有 detail 与 detail 为空串都不带破折号", () => {
    expect(errorTextOf("not_found")).toBe("[not_found] 目标不存在");
    expect(errorTextOf("not_found", "")).toBe("[not_found] 目标不存在");
  });

  it("未知码不崩，提示看日志", () => {
    expect(errorTextOf("something_new")).toContain("未知错误");
  });
});

const CTX = fakeContextOf().ctx;

const fakeOf = (routes: Parameters<typeof routedFetchOf>[0]) => {
  const routed = routedFetchOf(routes);
  const { deps } = fakeDepsOf({ home: "/home/u", daemon: DAEMON, fetch: routed.fetch });
  const fake = fakePiOf();
  hreaderExtensionOf(deps)(fake.pi);
  return { fake, routed };
};

describe("nodeSliceOf 的坏输入", () => {
  it("`<` 后面不是标签名（`<1 data-hr-id=…`）→ undefined", () => {
    expect(nodeSliceOf('<1 data-hr-id="x">正文</1>', "x")).toBeUndefined();
  });

  it("开标签没有 `>` 收尾 → undefined，不切半截", () => {
    expect(nodeSliceOf('<p data-hr-id="x" 正文', "x")).toBeUndefined();
  });

  it("外层没闭合、文件在最后一个 `</p` 处截断 → 循环走到头，返回 undefined", () => {
    expect(nodeSliceOf('<p data-hr-id="p1"><p></p', "p1")).toBeUndefined();
  });

  it("自闭合写法 `<img … />` 按自闭合收尾", () => {
    expect(nodeSliceOf('<img data-hr-id="y" src="a.png" />', "y")).toBe(
      '<img data-hr-id="y" src="a.png" />',
    );
  });
});

describe("解码器溢出", () => {
  it("缓冲超过上限后置 overflow，后续 push 直接空返回（不再囤字节）", () => {
    const decoder = createSseDecoder(8);
    expect(decoder.push(new TextEncoder().encode("x".repeat(64)))).toEqual([]);
    expect(decoder.overflowed()).toBe(true);
    expect(decoder.push(new TextEncoder().encode("more"))).toEqual([]);
  });
});

describe("hreader_read_node 的失败缝", () => {
  it("`/s/:docId` 连不上 → io_failure 文本", async () => {
    const { deps } = fakeDepsOf({
      home: "/home/u",
      daemon: DAEMON,
      fetch: () => Promise.reject(new Error("ECONNRESET")),
    });
    const fake = fakePiOf();
    hreaderExtensionOf(deps)(fake.pi);
    const result = await callToolOf(fake, "hreader_read_node", { path: "a.md", nodeId: "p1" }, CTX);
    expect(result.content[0]?.text).toContain("[io_failure]");
  });
});

describe("hreader_read_node 取不到批注时", () => {
  it("批注端点失败：节点照给，`annotations` 空、`revision` 缺省", async () => {
    const { fake } = fakeOf({
      "/s/": [{ text: '<p data-hr-id="p1">正文</p>' }],
      "/annotations": [{ status: 500, text: '{"code":"io_failure"}' }],
    });
    const result = await callToolOf(fake, "hreader_read_node", { path: "a.md", nodeId: "p1" }, CTX);
    expect(result.details["revision"]).toBeUndefined();
    expect(result.content[0]?.text).toContain('"annotations": []');
  });

  it("批注负载形状不对（非数组/非对象/空 id/非 pending）都跳过，不崩", async () => {
    const { fake } = fakeOf({
      "/s/": [{ text: '<p data-hr-id="p1">正文</p>' }],
      "/annotations": [
        {
          text: JSON.stringify({
            revision: 1,
            annotations: [
              42,
              {},
              { id: "", nodeId: "p1" },
              { id: "an-bad", nodeId: "", status: "pending_ai" },
              { id: "an-old", nodeId: "p1", status: "resolved" },
              { id: "an-ok", nodeId: "p1", status: "pending_ai" },
            ],
          }),
        },
      ],
    });
    const result = await callToolOf(fake, "hreader_read_node", { path: "a.md", nodeId: "p1" }, CTX);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("an-ok");
    expect(text).not.toContain("an-old");
    expect(text).not.toContain("an-bad");
  });
});

describe("hreader_read_node 的批注负载形状", () => {
  it("`annotations` 不是数组 → 当空处理", async () => {
    const { fake } = fakeOf({
      "/s/": [{ text: '<p data-hr-id="p1">正文</p>' }],
      "/annotations": [{ text: '{"revision":1,"annotations":"nope"}' }],
    });
    const result = await callToolOf(fake, "hreader_read_node", { path: "a.md", nodeId: "p1" }, CTX);
    expect(result.content[0]?.text).toContain('"annotations": []');
  });
});
