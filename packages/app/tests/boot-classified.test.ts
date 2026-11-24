// 这层管：`bootDocument` 的分流契约——info 先分档，managed 走原 `boot`、
// normalizable/foreign 走 iframe 壳（SSE 刷新、normalize 重进、destroy 三条路都钉住）。

import { describe, expect, it } from "vitest";

import { bootDocument, type ClassifiedBootDeps, type DocInfo } from "../src/boot.ts";
import type { SseHandlers } from "../src/sse.ts";
import { COPY } from "../src/widgets/copy.ts";
import { flush, harnessOf, type Harness } from "./support/boot-harness.ts";

const ROOT = "#hr-root";
const TEXT = `${ROOT} #hr-foreign-text`;
const ACTION = `${ROOT} #hr-foreign-action`;
const ERROR = `${ROOT} #hr-foreign-error`;
const FRAME = `${ROOT} #hr-foreign-frame`;

const attrsOf = (h: Harness, selector: string, name: string): readonly string[] =>
  h.fake.calls
    .filter((call) => call.op === "attr" && call.args[0] === selector && call.args[1] === name)
    .map((call) => call.args[2] ?? "");

const lastText = (h: Harness, selector: string): string | undefined =>
  h.fake.calls
    .filter((call) => call.op === "text" && call.args[0] === selector)
    .map((call) => call.args[1] ?? "")
    .at(-1);

interface Classified {
  readonly deps: ClassifiedBootDeps;
  readonly handlers: { current?: SseHandlers };
  readonly pageCalls: { count: number };
}

const classifiedOf = (
  h: Harness,
  info: () => DocInfo,
  over: Partial<ClassifiedBootDeps> = {},
): Classified => {
  const handlers: { current?: SseHandlers } = {};
  const pageCalls = { count: 0 };
  const deps: ClassifiedBootDeps = {
    ...h.deps,
    openSse: (next) => {
      handlers.current = next;
      return h.deps.openSse(next);
    },
    fetchInfo: () => Promise.resolve(info()),
    fetchPage: () => {
      pageCalls.count += 1;
      return Promise.resolve({
        themes: ["atelier-editorial"],
        defaultTheme: "atelier-editorial",
        documentHtml: "<article data-hr-id='hr-a'><p>新</p></article>",
      });
    },
    postTrust: (level) => Promise.resolve(level),
    postNormalize: () => Promise.resolve({ revision: "r2", cls: "managed" }),
    ...over,
  };
  return { deps, handlers, pageCalls };
};

const managedInfo: DocInfo = { revision: "r1", cls: "managed" };
const foreignInfo: DocInfo = { revision: "r1", cls: "foreign", trust: "off", scripts: true };
const normalizableInfo: DocInfo = { revision: "r1", cls: "normalizable" };

describe("bootDocument · 三类分流", () => {
  it("should run the original boot path unchanged for a managed document", async () => {
    const h = harnessOf(true);
    const { deps, pageCalls } = classifiedOf(h, () => managedInfo);

    const booted = await bootDocument(deps);
    await flush();

    // managed 的装配事实：正文 html 注入一次、主题下拉画过、水合拉过 model、键已绑定。
    expect(h.fake.ops()).toContain("html");
    expect(h.fake.ops()).toContain("children");
    expect(h.fetched.model).toBe(1);
    expect(h.keysBound()).toBe(1);
    expect(pageCalls.count).toBe(1);
    // iframe 路径的东西一个都没出现。
    expect(attrsOf(h, FRAME, "src")).toEqual([]);

    booted.destroy();
    expect(h.closed()).toBe(true);
  });

  it("should mount the iframe shell without touching model-facing features for foreign docs", async () => {
    const h = harnessOf(true);
    const { deps, pageCalls } = classifiedOf(h, () => foreignInfo);

    const booted = await bootDocument(deps);

    expect(attrsOf(h, FRAME, "src")).toEqual(["/s/doc.html"]);
    expect(attrsOf(h, FRAME, "sandbox")).toEqual([""]);
    expect(lastText(h, TEXT)).toContain(COPY.foreignReadonly);
    expect(lastText(h, `${ROOT} #hr-shortcuts`)).toBe(COPY.foreignShortcuts);
    // model 系功能不接线：正文不注入、model/outline 不拉、键盘不绑、主题不选。
    expect(h.fake.ops()).not.toContain("html");
    expect(h.fetched.model).toBe(0);
    expect(h.fetched.outline).toBe(0);
    expect(h.keysBound()).toBe(0);
    expect(pageCalls.count).toBe(0);
    expect(booted.selection).toBeUndefined();

    booted.destroy();
    expect(h.closed()).toBe(true);
  });

  it("should mount the iframe shell with the normalize banner for normalizable docs", async () => {
    const h = harnessOf(true);
    const { deps } = classifiedOf(h, () => normalizableInfo);

    await bootDocument(deps);

    expect(attrsOf(h, FRAME, "src")).toEqual(["/s/doc.html"]);
    expect(lastText(h, TEXT)).toBe(COPY.normalizableBanner);
    expect(lastText(h, ACTION)).toBe(COPY.normalizableAction);
    expect(h.fetched.model).toBe(0);
  });
});

describe("bootDocument · SSE 与状态", () => {
  it("should reload the iframe on doc.changed / doc.reloaded and ignore other events", async () => {
    const h = harnessOf(true);
    const { deps, handlers } = classifiedOf(h, () => foreignInfo);
    await bootDocument(deps);

    handlers.current?.onEvent({ id: 1, type: "library.changed", payload: {} });
    handlers.current?.onEvent({
      id: 2,
      type: "doc.changed",
      payload: { revision: "r2", changedNodes: [] },
    });
    handlers.current?.onEvent({ id: 3, type: "doc.reloaded", payload: {} });
    handlers.current?.onEvent({ id: 4, type: "doc.changed", payload: { revision: "r3" } });

    expect(attrsOf(h, FRAME, "src")).toEqual([
      "/s/doc.html",
      "/s/doc.html?r=r2",
      "/s/doc.html?r=n1",
      "/s/doc.html?r=r3",
    ]);
  });

  it("should paint the SSE connection state through the statusbar", async () => {
    const h = harnessOf(true);
    const { deps, handlers } = classifiedOf(h, () => foreignInfo);
    await bootDocument(deps);

    handlers.current?.onState("live");

    expect(h.store.get().conn).toBe("live");
    expect(lastText(h, `${ROOT} #hr-conn`)).toBe(COPY.statusLive);
  });
});

describe("bootDocument · 信任开关", () => {
  it("should POST the trust level and re-sandbox + reload the iframe", async () => {
    const h = harnessOf(true);
    const asked: string[] = [];
    const { deps } = classifiedOf(h, () => foreignInfo, {
      postTrust: (level) => {
        asked.push(level);
        return Promise.resolve(level);
      },
    });
    await bootDocument(deps);

    h.fake.fire(ACTION, "click", {});
    await flush();

    expect(asked).toEqual(["local"]);
    expect(attrsOf(h, FRAME, "sandbox").at(-1)).toBe("allow-scripts");
    expect(attrsOf(h, FRAME, "src").at(-1)).toBe("/s/doc.html?r=n1");
  });
});

describe("bootDocument · normalize 重进", () => {
  it("should re-boot as managed after a successful normalize", async () => {
    const h = harnessOf(true);
    let info = normalizableInfo;
    let posted = 0;
    const { deps } = classifiedOf(h, () => info, {
      postNormalize: () => {
        posted += 1;
        info = { revision: "r2", cls: "managed" };
        return Promise.resolve({ revision: "r2", cls: "managed" });
      },
    });
    const booted = await bootDocument(deps);

    h.fake.fire(ACTION, "click", {});
    await flush();
    await flush();

    expect(posted).toBe(1);
    // 重进 managed：正文注入、model 水合、键盘绑定、外来壳拆掉（attr 摘除 + iframe 隐藏）。
    expect(h.fetched.model).toBe(1);
    expect(h.keysBound()).toBe(1);
    expect(h.fake.ops()).toContain("html");
    expect(attrsOf(h, ROOT, "data-hr-doc").at(-1)).toBe("<removed>");
    expect(attrsOf(h, FRAME, "hidden").at(-1)).toBe("");
    // destroy 转给 managed 实例：关掉的是重开后那条 SSE。
    booted.destroy();
    expect(h.closed()).toBe(true);
  });

  it("should keep the foreign shell and show the error when normalize fails", async () => {
    const h = harnessOf(true);
    const { deps } = classifiedOf(h, () => normalizableInfo, {
      postNormalize: () => Promise.reject(new Error("normalize: locked")),
    });
    await bootDocument(deps);

    h.fake.fire(ACTION, "click", {});
    await flush();

    expect(lastText(h, ERROR)).toBe("normalize: locked");
    // 壳还在：iframe 没被隐藏，也没有 managed 装配发生。
    expect(attrsOf(h, FRAME, "hidden")).toEqual(["<removed>"]);
    expect(h.fake.ops()).not.toContain("html");
  });

  it("should destroy the re-booted reader when destroyed mid-normalize", async () => {
    const h = harnessOf(true);
    let info = normalizableInfo;
    let release: () => void = () => undefined;
    const { deps } = classifiedOf(h, () => info, {
      postNormalize: () =>
        new Promise((resolve) => {
          release = () => {
            info = { revision: "r2", cls: "managed" };
            resolve({ revision: "r2", cls: "managed" });
          };
        }),
    });
    const booted = await bootDocument(deps);
    h.fake.fire(ACTION, "click", {});
    await flush();

    // normalize 在途时 destroy：壳拆掉；重进完成后新实例必须立刻销毁（不挂孤儿 SSE）。
    booted.destroy();
    expect(h.closed()).toBe(true);
    release();
    await flush();
    await flush();

    expect(h.fake.ops()).toContain("html");
    expect(h.fake.ops().at(-1)).toBe("destroy");
  });

  it("should not tear down twice on a second destroy", async () => {
    const h = harnessOf(true);
    const { deps } = classifiedOf(h, () => foreignInfo);
    const booted = await bootDocument(deps);

    booted.destroy();
    const callsAfterFirst = h.fake.calls.length;
    booted.destroy();

    expect(h.fake.calls.length).toBe(callsAfterFirst);
  });
});
