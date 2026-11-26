// Corners of the pure layer and the tools' failure seams: path building with missing params, the error-text
// detail forks, bad input to node slicing, decoder overflow, an unreachable `/s/:docId`, and malformed
// annotation payloads. Every "defensive branch" needs an input that really reaches it.

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

describe("pathOf missing-param fallback", () => {
  it("should encode a missing placeholder value as an empty segment without throwing", () => {
    expect(pathOf(ENDPOINTS.outline)).toBe("/api/doc//outline");
  });
});

describe("errorTextOf message forks", () => {
  it("should emit no dash for absent or empty detail", () => {
    expect(errorTextOf("not_found")).toBe("[not_found] 目标不存在");
    expect(errorTextOf("not_found", "")).toBe("[not_found] 目标不存在");
  });

  it("should not crash on an unknown code and should point at the logs", () => {
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

describe("nodeSliceOf bad input", () => {
  it("should return undefined when `<` is not followed by a tag name (`<1 data-hr-id=…`)", () => {
    expect(nodeSliceOf('<1 data-hr-id="x">正文</1>', "x")).toBeUndefined();
  });

  it("should return undefined when the open tag never closes with `>`, rather than slicing halfway", () => {
    expect(nodeSliceOf('<p data-hr-id="x" 正文', "x")).toBeUndefined();
  });

  it("should run the loop to the end and return undefined when the outer tag never closes and the file truncates at the last `</p`", () => {
    expect(nodeSliceOf('<p data-hr-id="p1"><p></p', "p1")).toBeUndefined();
  });

  it("should end a self-closing `<img … />` at the tag itself", () => {
    expect(nodeSliceOf('<img data-hr-id="y" src="a.png" />', "y")).toBe(
      '<img data-hr-id="y" src="a.png" />',
    );
  });
});

describe("decoder overflow", () => {
  it("should set overflow past the limit and make later pushes return empty (no more byte hoarding)", () => {
    const decoder = createSseDecoder(8);
    expect(decoder.push(new TextEncoder().encode("x".repeat(64)))).toEqual([]);
    expect(decoder.overflowed()).toBe(true);
    expect(decoder.push(new TextEncoder().encode("more"))).toEqual([]);
  });
});

describe("hreader_read_node failure seams", () => {
  it("should return io_failure text when `/s/:docId` is unreachable", async () => {
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

describe("hreader_read_node when annotations cannot be fetched", () => {
  it("should still return the node with empty `annotations` and an absent `revision` when the annotation endpoint fails", async () => {
    const { fake } = fakeOf({
      "/s/": [{ text: '<p data-hr-id="p1">正文</p>' }],
      "/annotations": [{ status: 500, text: '{"code":"io_failure"}' }],
    });
    const result = await callToolOf(fake, "hreader_read_node", { path: "a.md", nodeId: "p1" }, CTX);
    expect(result.details["revision"]).toBeUndefined();
    expect(result.content[0]?.text).toContain('"annotations": []');
  });

  it("should skip malformed annotation entries (non-array/non-object/empty id/non-pending) without crashing", async () => {
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

describe("hreader_read_node annotation payload shapes", () => {
  it("should treat a non-array `annotations` as empty", async () => {
    const { fake } = fakeOf({
      "/s/": [{ text: '<p data-hr-id="p1">正文</p>' }],
      "/annotations": [{ text: '{"revision":1,"annotations":"nope"}' }],
    });
    const result = await callToolOf(fake, "hreader_read_node", { path: "a.md", nodeId: "p1" }, CTX);
    expect(result.content[0]?.text).toContain('"annotations": []');
  });
});
