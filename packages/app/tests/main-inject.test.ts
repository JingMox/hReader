// 这层管：**注入式入口**（`@internal main` / `bootWith`）的接线与守卫——
// 手册 §10.7 的接缝规则：从真实入口进、走真实路由代码，不许在中间层直接
// `settleTheme` / `store.dispatch({kind:"themeSelected"})`。
// 与 `main.test.ts` 分开是因为两者共用 `support/main-stubs.ts` 的全局桩会互相打架，
// 也为了让单个 describe 的函数体保持在 lint 的行数上限内。

import { describe, expect, it, vi } from "vitest";

import type { Host } from "../src/dom.ts";
import type { AppIo } from "../src/main.ts";
import {
  ARTICLE,
  CSS,
  flush,
  installGlobals,
  model,
  outline,
  themes,
} from "./support/main-stubs.ts";

interface RecordedHost {
  readonly texts: [string, string][];
  readonly host: Host;
  readonly fireChange: (value: string) => void;
}

const recordingHostOf = (): RecordedHost => {
  const texts: [string, string][] = [];
  const handlers = new Map<string, (target: { value?: string }) => void>();
  const noop = (): void => undefined;
  const host: Host = {
    text: (selector, value) => {
      texts.push([selector, value]);
    },
    attr: noop,
    html: noop,
    cls: noop,
    children: noop,
    blocks: () => new Map(),
    blockHtml: noop,
    removeBlock: noop,
    on: (selector, type, handler) => {
      handlers.set(`${selector}|${type}`, handler);
      return () => undefined;
    },
    focus: noop,
    scrollTo: noop,
    destroy: noop,
  };
  return {
    texts,
    host,
    fireChange: (value) => {
      handlers.get("#hr-root #hr-theme-select|change")?.({ value });
    },
  };
};

/** 注入式 IO：按路径回放 `themes` / `model` / `outline`，主题 CSS 走 `css`；`asked` 记下取过哪些路径。 */
const ioOf = (css: string, asked: string[] = []): AppIo => ({
  text: (path) => {
    asked.push(path);
    return Promise.resolve(path.startsWith("/api/theme/") ? css : ARTICLE);
  },
  json: (path, guard) => {
    const candidate: unknown =
      path === "/api/theme" ? themes : path.endsWith("/model") ? model : outline;
    return guard(candidate)
      ? Promise.resolve(candidate)
      : Promise.reject(new Error(`${path} → 响应形状不符`));
  },
});

/** 指定路径的主题 CSS 读取必失败，其余照常——断言"失败不改写 `<style>`"。 */
const failingIoOf = (broken: string): AppIo => ({
  text: (path) =>
    path === broken ? Promise.reject(new Error(`${path} → 500`)) : Promise.resolve(ARTICLE),
  json: (path, guard) => {
    const candidate: unknown = path === "/api/theme" ? themes : outline;
    return guard(candidate)
      ? Promise.resolve(candidate)
      : Promise.reject(new Error(`${path} → 响应形状不符`));
  },
});

describe("main · 注入面（@internal bootWith / main） · 入口与守卫", () => {
  it("should explain how to open a document when the injected source has no id", async () => {
    installGlobals("doc.html", "http://x/");
    const { texts, host } = recordingHostOf();

    const { main } = await import("../src/main.ts");

    await main({ host, io: ioOf(CSS), docIdSource: { attr: null, href: "http://x/" } });

    expect(texts).toEqual([["#hr-doc", "没有指定文档：用 /?doc=<docId> 打开"]]);
  });

  it("should reject when an injected insight payload fails its guard", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const { host } = recordingHostOf();

    const { main } = await import("../src/main.ts");

    await expect(
      main({
        host,
        docIdSource: { attr: "doc.html", href: "http://x/" },
        io: {
          text: () => Promise.resolve(ARTICLE),
          json: () => Promise.reject(new Error("assertThemeList: 响应形状不符")),
        },
      }),
    ).rejects.toThrow("响应形状不符");
  });
});

describe("main · 注入面（@internal bootWith / main） · 主题接线", () => {
  it("should write the picked theme's CSS into #hr-theme exactly once", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const { texts, host, fireChange } = recordingHostOf();

    const { bootWith } = await import("../src/main.ts");

    const booted = bootWith({
      docId: "doc.html",
      themes: { themes: ["atelier-editorial", "manuscript"], default: "atelier-editorial" },
      documentHtml: ARTICLE,
      io: ioOf(CSS),
      host,
    });
    fireChange("manuscript");
    await flush();

    expect(texts.filter(([selector]) => selector === "#hr-theme")).toEqual([["#hr-theme", CSS]]);
    booted.destroy();
  });
});

describe("main · 守卫与兜底的剩余分支（G3-R4）", () => {
  it("should reject a non-record theme list before touching its fields", async () => {
    const { isThemeList } = await import("../src/main.ts");

    expect(isThemeList(null)).toBe(false);
    expect(isThemeList("themes")).toBe(false);
    expect(isThemeList([themes])).toBe(false);
    expect(isThemeList(themes)).toBe(true);
  });

  it("should turn a 200 with the wrong shape into a readable error for a own guard", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );
    const { createHttpIo, isModelResponse } = await import("../src/main.ts");

    await expect(createHttpIo().json("/api/doc/doc.html/model", isModelResponse)).rejects.toThrow(
      "/api/doc/doc.html/model → 响应形状不符",
    );
  });

  it("should render a non-Error rejection as text instead of crashing", async () => {
    const { reportFailure } = await import("../src/main.ts");
    const { texts, host } = recordingHostOf();

    reportFailure(host, "boom");

    expect(texts).toEqual([["#hr-doc", "打开失败：boom"]]);
  });
});

describe("main · 端到端接线（入口 → host 事件 → dispatchIntent → widget）", () => {
  // 手册 §10.7：接缝必须从真实入口进、走真实路由代码，不许在中间层直接调
  // `settleTheme` / `store.dispatch({kind:"themeSelected"})`——那正是 G3-R3 漏掉的东西。
  it("should write the theme CSS when the user changes the select after booting via main()", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const { texts, host, fireChange } = recordingHostOf();
    const asked: string[] = [];
    const io = ioOf(CSS, asked);

    const { main } = await import("../src/main.ts");
    await main({ host, io, docIdSource: { attr: "doc.html", href: "http://x/" } });
    await flush();

    // 首屏主题与默认值相同 → 尚不该写 CSS（applyFirstTheme 走 unchanged）。
    expect(texts.filter(([selector]) => selector === "#hr-theme")).toEqual([]);

    fireChange("manuscript");
    await flush();

    // ① 内容来自 io（不是常量）；② 只写一次；③ 请求的是用户刚选的那一个。
    expect(asked).toContain("/api/theme/manuscript");
    expect(texts.filter(([selector]) => selector === "#hr-theme")).toEqual([["#hr-theme", CSS]]);
  });

  it("should keep the previous CSS when the picked theme fails to load", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const { texts, host, fireChange } = recordingHostOf();
    const failing = failingIoOf("/api/theme/broken");

    const { main } = await import("../src/main.ts");
    await main({ host, io: failing, docIdSource: { attr: "doc.html", href: "http://x/" } });
    await flush();

    fireChange("broken");
    await flush();

    // 失败不改写 `<style>`（applyCss 没被调），页面继续用上一份 CSS。
    expect(texts.filter(([selector]) => selector === "#hr-theme")).toEqual([]);
  });
});
