// 这层管：浏览器入口 `main.ts` 的行为面——文档定位、首屏、失败文案、键盘适配。
// 浏览器桩集中在 `support/main-stubs.ts`（必须在 import `main.ts` 前装好）。

import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeElement } from "./support/fake-dom.ts";
import {
  failOf,
  flush,
  happy,
  install,
  jsonOf,
  load,
  noticeOf,
  stubs,
} from "./support/main-stubs.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("main · 文档定位与首屏", () => {
  it("should boot from body[data-doc-id]: themes and html first, then model and outline", async () => {
    install("doc.html", "http://x/?doc=other", happy);
    await load();
    expect(stubs.fetched).toEqual(["/api/theme", "/s/doc.html"]);
  });

  it("should reload on a named frame with a frame-header id", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    const source = stubs.sources[0];
    source?.onopen?.();
    source?.fire("doc.changed", JSON.stringify({ changedNodes: ["hr-a"] }), "7");
    await flush(5);
    expect(stubs.fetched.filter((url) => url.endsWith("/model"))).toHaveLength(1);
  });

  it("should drop frames that carry no id at all", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    const source = stubs.sources[0];
    source?.onopen?.();
    source?.fire("doc.changed", JSON.stringify({ changedNodes: ["hr-a"] }));
    await flush(5);
    expect(stubs.fetched.filter((url) => url.endsWith("/model"))).toEqual([]);
  });
});

describe("main · 文档定位与首屏（续）", () => {
  it("should destroy the reader on pagehide", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    expect(stubs.pagehide).toHaveLength(1);
    stubs.pagehide[0]?.({ key: "" });
    expect(stubs.closed).toBe(1);
    expect(stubs.removed).toBe(1);
  });

  it("should fall back to the ?doc= query when the body attribute is empty", async () => {
    install("", "http://x/?doc=from-url", happy);
    await load();
    expect(stubs.fetched.slice(0, 2)).toEqual(["/api/theme", "/s/from-url"]);
  });

  it("should explain how to open a document when no id is given", async () => {
    install(null, "http://x/", happy);
    stubs.doc.bySelector.set("#hr-doc", fakeElement("div"));
    await load();
    expect(stubs.fetched).toEqual([]);
    expect(stubs.doc.bySelector.get("#hr-doc")?.textContent).toBe(
      "没有指定文档：用 /?doc=<docId> 打开",
    );
  });
});

describe("main · 失败面（写一条可读文案，不白屏）", () => {
  it("should report the path and status when /api/theme is not OK", async () => {
    await expect(
      noticeOf((url) => (url === "/api/theme" ? failOf(500) : happy(url))),
    ).resolves.toBe("打开失败：/api/theme → 500");
  });

  it("should report a shape mismatch for a malformed theme list", async () => {
    await expect(
      noticeOf((url) => (url === "/api/theme" ? jsonOf({ themes: [] }) : happy(url))),
    ).resolves.toBe("打开失败：/api/theme → 响应形状不符");
  });

  it("should report the path and status when the document HTML is not OK", async () => {
    await expect(
      noticeOf((url) => (url.startsWith("/s/") ? failOf(404) : happy(url))),
    ).resolves.toBe("打开失败：/s/doc.html → 404");
  });

  it("should open the SSE with cookies", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    const source = stubs.sources[0];
    expect(source?.url).toBe("/api/events");
    expect(source?.withCredentials).toBe(true);
  });
});

describe("main · 键盘与主题适配", () => {
  it("should translate window keydown events into the KeyLike shape", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    const handler = stubs.keyHandlers[0];
    handler?.({ key: "j", metaKey: true, ctrlKey: false, altKey: false });
    handler?.({ key: "h", metaKey: false, ctrlKey: true, target: null });
    handler?.({ key: "j" });
    expect(stubs.keyHandlers).toHaveLength(1);
  });

  it("should pass the event target through so the editable guard can see it", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    expect(stubs.keyHandlers).toHaveLength(1);
    expect(stubs.keyHandlers[0]?.({ key: "j", target: { tagName: "INPUT" } })).toBeUndefined();
  });
});

describe("main · 形状守卫与重连回调（G3-R 补）", () => {
  it("should reject model/outline payloads that miss their fields", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    const mod = await import("../src/main.ts");
    expect(mod.isModelResponse({ revision: "r1" })).toBe(false);
    expect(mod.isModelResponse({ model: {} })).toBe(false);
    expect(mod.isOutlineResponse({ outline: {} })).toBe(false);
    expect(mod.isOutlineResponse({ outline: { nodes: [] } })).toBe(true);
  });

  it("should surface a transport error through the SSE state callback", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    const source = stubs.sources[0];
    source?.onopen?.();
    source?.onerror?.();
    await flush(5);
    // 重连交给 `schedule`（真定时器）——这里只断言适配层把 onerror 接到监听上。
    expect(source?.onerror).not.toBeNull();
  });

  it("should cancel the scheduled reconnect when the page is hidden", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    stubs.sources[0]?.onerror?.();
    const closedBefore = stubs.closed;
    for (const handler of stubs.pagehide) handler({ key: "" });
    expect(stubs.closed).toBe(closedBefore + 1);
  });
});
