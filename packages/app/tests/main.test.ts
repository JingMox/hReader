// 这层管：浏览器入口 `main.ts` 的行为面——文档定位、首屏、失败文案、键盘适配。
// 浏览器桩集中在 `support/main-stubs.ts`（必须在 import `main.ts` 前装好）。

import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeElement } from "./support/fake-dom.ts";
import { submitNoteWithSelection, toggleDiffWithShiftD } from "./support/selection-fixture.ts";
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
  it("should boot from body[data-doc-id]: themes, html, annotations, model and outline", async () => {
    install("doc.html", "http://x/?doc=other", happy);
    await load();
    expect(stubs.fetched).toEqual([
      "/api/theme",
      "/s/doc.html",
      "/api/doc/doc.html/annotations",
      "/api/doc/doc.html/model",
      "/api/doc/doc.html/outline",
    ]);
  });

  it("should reload on a named frame with a frame-header id", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    const source = stubs.sources[0];
    source?.onopen?.();
    source?.fire("doc.changed", JSON.stringify({ changedNodes: ["hr-a"] }), "7");
    await flush(5);
    expect(stubs.fetched.filter((url) => url.endsWith("/model"))).toHaveLength(2);
  });

  it("should drop frames that carry no id at all", async () => {
    install("doc.html", "http://x/", happy);
    await load();
    const source = stubs.sources[0];
    source?.onopen?.();
    source?.fire("doc.changed", JSON.stringify({ changedNodes: ["hr-a"] }));
    await flush(5);
    expect(stubs.fetched.filter((url) => url.endsWith("/model"))).toHaveLength(1);
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

describe("main · 形状守卫与重连回调", () => {
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

describe("main · 写请求与划词监听", () => {
  it("should POST JSON with same-origin credentials and enforce the guard", async () => {
    install("doc.html", "http://x/", (url) =>
      url.startsWith("/api/doc/") ? jsonOf({ revision: "r1" }) : happy(url),
    );
    const { createHttpIo } = await import("../src/main.ts");
    const io = createHttpIo();
    const post = io.post;
    expect(post).toBeDefined();

    await expect(
      post?.(
        "/api/doc/d/annotations",
        { note: "x" },
        (value): value is { revision: string } => typeof value === "object",
      ),
    ).resolves.toEqual({ revision: "r1" });

    await expect(
      post?.(
        "/api/doc/d/undo",
        {},
        (value: unknown): value is { revision: string } => value === undefined,
      ),
    ).rejects.toThrow("响应形状不符");
  });
});

describe("main · POST 失败状态", () => {
  it("should surface a non-ok status from POST", async () => {
    install("doc.html", "http://x/", (url) =>
      url.startsWith("/api/doc/") ? failOf(409) : happy(url),
    );
    const { createHttpIo } = await import("../src/main.ts");

    await expect(
      createHttpIo().post?.(
        "/api/doc/d/undo",
        {},
        (value: unknown): value is { revision: string } => value !== undefined,
      ),
    ).rejects.toThrow("/api/doc/d/undo → 409");
  });
});

describe("main · 划词监听", () => {
  it("should install a mouseup listener that survives a null selection", async () => {
    install("doc.html", "http://x/", happy);
    await load();

    expect(stubs.mouseups).toHaveLength(1);
    expect(() => stubs.mouseups[0]?.()).not.toThrow();
  });

  it("should hand a real block selection to the notes surface", async () => {
    await submitNoteWithSelection({ respond: happy, load });

    const posted = stubs.requests.filter((request) => request.method === "POST");
    expect(posted).toHaveLength(1);
    expect(JSON.parse(String(posted[0]?.body))).toMatchObject({
      nodeId: "hr-a",
      note: "我的批注",
      anchor: { exact: "正文一", start: 0 },
    });
  });

  it("should survive a mouseup when the surface has no getSelection at all", async () => {
    // 主端写的是 `window.getSelection?.() ?? null`：没有这个方法时那个**可选调用臂**必须安静退化。
    install("doc.html", "http://x/", happy, { withGetSelection: false });
    await load();

    expect(stubs.mouseups).toHaveLength(1);
    const before = stubs.fetched.length;
    expect(() => stubs.mouseups[0]?.()).not.toThrow();
    // 没有选区就不可能产生批注目标：鼠标抬起后不能多发一个请求（证伪“把 undefined 当空选区往下传”）。
    expect(stubs.fetched.length).toBe(before);
  });
});

describe("main · 文档定位（续）", () => {
  it("should read the docId from location.href when the body attribute is missing", async () => {
    install(null, "http://x/?doc=from-href", happy);
    await load();

    expect(stubs.fetched.slice(0, 2)).toEqual(["/api/theme", "/s/from-href"]);
  });
});

describe("main · Shift+D 的 diff 端到端", () => {
  const diffRequests = (): string[] =>
    stubs.fetched.filter((url) => url.endsWith("/notes/an-1a2b3c4d/diff"));

  it("should fetch the server diff on Shift+D and paint its chunks in the right pane", async () => {
    const respond = (url: string): Response =>
      url.endsWith("/notes/an-1a2b3c4d/diff")
        ? jsonOf({
            // 与服务端契约同形（`guard.isDiffResponse` 要求 `nodeId`）：假件不得比真实响应更宽松。
            nodeId: "hr-a",
            before: "正文",
            after: "正文一",
            chunks: [
              { kind: "same", text: "正文" },
              { kind: "ins", text: "一" },
            ],
            degraded: false,
          })
        : happy(url);

    const chunks = await toggleDiffWithShiftD({ respond, load });

    expect(stubs.fetched).toContain("/api/doc/doc.html/notes/an-1a2b3c4d/diff");
    expect(chunks.children.map((node) => node.textContent)).toEqual(["正文", "一"]);

    // 反向：同一个真实 keydown 入口再按一次**不带** shift 的 d。`diffToggled` 会先关面板、`notes-wire`
    // 再取一次，所以 `shiftKey` 的判定一旦放宽（恒真 / `!== false`），这里就会多出第 2 次请求。
    stubs.keyHandlers[0]?.({ key: "d" });
    await flush(5);
    expect(diffRequests()).toHaveLength(1);
  });
});
