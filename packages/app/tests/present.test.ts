// 这层管：演示模式——reduce 的页码钳制、widget 的 data 属性同步、步进拦截、
// hash 续页与全屏副作用、退出时的清理与滚动复位。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { boot } from "../src/boot.ts";
import { reduce, type ReaderIntent, type ReaderState } from "../src/state.ts";
import { mountPresent, type PresentShell } from "../src/widgets/present.ts";
import { flush, harnessOf } from "./support/boot-harness.ts";
import { fakeElement } from "./support/fake-dom.ts";
import { createFakeHost, stateOf, type FakeHost } from "./support/fake-host.ts";

const ROOT = "#hr-root";
const SLIDES_HTML = '<article data-hr-kind="slides"><h1>t</h1><section>s</section></article>';
const NOTE_HTML = '<article data-hr-kind="note"><h1>t</h1><section>s</section></article>';

const dispatch = (state: ReaderState, intent: ReaderIntent): ReaderState => reduce(state, intent);

const presenting = (over: Partial<ReaderState> = {}): ReaderState =>
  stateOf({
    pages: ["hr-a", "hr-b", "hr-c"],
    present: { active: true, page: 1 },
    documentHtml: SLIDES_HTML,
    ...over,
  });

interface ShellLog {
  readonly enters: number[];
  readonly exits: number[];
  readonly writes: string[];
  hash: string;
  inFs: boolean;
}

interface FakeShell {
  readonly shell: PresentShell;
  readonly log: ShellLog;
  readonly fireFsChange: () => void;
}

const shellOf = (init: { readonly hash?: string } = {}): FakeShell => {
  const log: ShellLog = {
    enters: [],
    exits: [],
    writes: [],
    hash: init.hash ?? "",
    inFs: false,
  };
  const listeners: (() => void)[] = [];
  return {
    shell: {
      fullscreen: {
        enter: () => {
          log.enters.push(1);
          log.inFs = true;
        },
        exit: () => {
          log.exits.push(1);
          log.inFs = false;
        },
      },
      isFullscreen: () => log.inFs,
      onFullscreenChange: (handler) => {
        listeners.push(handler);
        return () => undefined;
      },
      hash: {
        read: () => log.hash,
        write: (hash) => {
          log.writes.push(hash);
          log.hash = hash;
        },
      },
    },
    log,
    fireFsChange: () => {
      for (const listener of listeners) listener();
    },
  };
};

const mountOf = (
  fake: FakeHost,
  shell: PresentShell,
  intents: ReaderIntent[] = [],
): ReturnType<typeof mountPresent> =>
  mountPresent({
    host: fake.host,
    parent: ROOT,
    shell,
    onIntent: (intent) => {
      intents.push(intent);
    },
  });

const slideAttrs = (fake: FakeHost): readonly (readonly [string, string])[] =>
  fake.calls
    .filter((call) => call.op === "attr" && call.args[1] === "data-hr-slide-state")
    .map((call) => [call.args[0] ?? "", call.args[2] ?? ""]);

const stepSelector = (id: string): string => `${ROOT} [data-hr-id="${id}"] [data-hr-step]`;

describe("reduce · 演示页码", () => {
  const entered = dispatch(stateOf({ pages: ["a", "b", "c"] }), { kind: "presentEntered" });

  it("should enter present mode at page 0", () => {
    expect(entered.present).toEqual({ active: true, page: 0 });
  });

  it("should refuse to enter when there are no pages", () => {
    const state = stateOf();
    expect(dispatch(state, { kind: "presentEntered" })).toBe(state);
  });

  it("should clamp the requested page into range", () => {
    const state = dispatch(stateOf({ pages: ["a", "b"] }), {
      kind: "presentEntered",
      page: 9,
    });
    expect(state.present).toEqual({ active: true, page: 1 });
  });

  it("should ignore entry while already presenting", () => {
    const state = presenting();
    expect(dispatch(state, { kind: "presentEntered" })).toBe(state);
  });

  it("should resume the stored page on re-entry", () => {
    const exited = dispatch(presenting({ present: { active: true, page: 2 } }), {
      kind: "presentExited",
    });
    const reentered = dispatch(exited, { kind: "presentEntered" });
    expect(reentered.present).toEqual({ active: true, page: 2 });
  });

  it("should exit and keep the page for the next entry", () => {
    const exited = dispatch(presenting(), { kind: "presentExited" });
    expect(exited.present).toEqual({ active: false, page: 1 });
  });

  it("should no-op exit when not presenting", () => {
    const state = stateOf();
    expect(dispatch(state, { kind: "presentExited" })).toBe(state);
  });

  it("should ignore navigation intents while not presenting", () => {
    const state = stateOf({ pages: ["a", "b"] });
    for (const intent of [
      { kind: "presentMoved", page: 1 },
      { kind: "presentAdvanced" },
      { kind: "presentBack" },
    ] as const) {
      expect(dispatch(state, intent)).toBe(state);
    }
  });

  it("should advance and go back within bounds without wrapping", () => {
    const state = presenting({ present: { active: true, page: 1 } });
    expect(dispatch(state, { kind: "presentAdvanced" }).present.page).toBe(2);
    expect(dispatch(state, { kind: "presentBack" }).present.page).toBe(0);
    const last = presenting({ present: { active: true, page: 2 } });
    expect(dispatch(last, { kind: "presentAdvanced" })).toBe(last);
    const first = presenting({ present: { active: true, page: 0 } });
    expect(dispatch(first, { kind: "presentBack" })).toBe(first);
  });

  it("should jump to a clamped page and keep state when unchanged", () => {
    const state = presenting();
    expect(dispatch(state, { kind: "presentMoved", page: 99 }).present.page).toBe(2);
    expect(dispatch(state, { kind: "presentMoved", page: 1 })).toBe(state);
  });

  it("should update pages on blocksLoaded and keep them when omitted", () => {
    const loaded = dispatch(stateOf(), {
      kind: "blocksLoaded",
      blocks: ["a"],
      outline: [],
      pages: ["a", "b"],
    });
    expect(loaded.pages).toEqual(["a", "b"]);
    const again = dispatch(loaded, {
      kind: "blocksLoaded",
      blocks: ["a"],
      outline: [],
      html: "x",
    });
    expect(again.pages).toEqual(["a", "b"]);
  });
});

describe("present · 入口按钮与页码", () => {
  const kindSelector = `${ROOT} article[data-hr-kind="slides"]`;

  it("should show the button only for slides documents", () => {
    const fake = createFakeHost();
    const widget = mountOf(fake, shellOf().shell);
    widget.update(stateOf({ documentHtml: NOTE_HTML }));
    let hidden = fake.calls.filter(
      (call) => call.op === "attr" && call.args[0] === `${ROOT} #hr-present-btn`,
    );
    expect(hidden.at(-1)?.args[2]).toBe("");
    // kind 读的是挂载出的 `<article>` 的 DOM 属性：主题 CSS 里就含 `data-hr-kind="slides"` 选择器文本，
    // 对 `documentHtml` 做字符串匹配会连 note 文档都误判成 slides。
    fake.all.set(kindSelector, [fakeElement("article")]);
    widget.update(stateOf({ documentHtml: SLIDES_HTML }));
    hidden = fake.calls.filter(
      (call) => call.op === "attr" && call.args[0] === `${ROOT} #hr-present-btn`,
    );
    expect(hidden.at(-1)?.args[2]).toBe("<removed>");
  });

  it("should dispatch enter/exit intents from the two buttons", () => {
    const fake = createFakeHost();
    const intents: ReaderIntent[] = [];
    mountOf(fake, shellOf().shell, intents);
    fake.fire(`${ROOT} #hr-present-btn`, "click", {});
    fake.fire(`${ROOT} #hr-present-exit`, "click", {});
    expect(intents).toEqual([{ kind: "presentEntered" }, { kind: "presentExited" }]);
  });

  it("should paint per-page states, pager, fullscreen and hash on enter", () => {
    const fake = createFakeHost();
    const { shell, log } = shellOf();
    const widget = mountOf(fake, shell);
    widget.update(presenting({ present: { active: true, page: 1 } }));
    expect(
      fake.calls.some(
        (call) => call.op === "attr" && call.args[0] === ROOT && call.args[1] === "data-hr-present",
      ),
    ).toBe(true);
    expect(log.enters).toHaveLength(1);
    expect(log.writes.at(-1)).toBe("p=2");
    const pager = fake.calls
      .filter((call) => call.op === "text" && call.args[0] === `${ROOT} #hr-present-pager`)
      .at(-1);
    expect(pager?.args[1]).toBe("2 / 3");
    const states = Object.fromEntries(
      slideAttrs(fake).map(([selector, value]) => [selector, value]),
    );
    expect(states[`${ROOT} [data-hr-id="hr-a"]`]).toBe("past");
    expect(states[`${ROOT} [data-hr-id="hr-b"]`]).toBe("current");
    expect(states[`${ROOT} [data-hr-id="hr-c"]`]).toBe("future");
  });

  it("should repaint states and hash when the page changes", () => {
    const fake = createFakeHost();
    const { shell, log } = shellOf();
    const widget = mountOf(fake, shell);
    widget.update(presenting({ present: { active: true, page: 0 } }));
    widget.update(presenting({ present: { active: true, page: 2 } }));
    expect(log.writes).toEqual(["p=1", "p=3"]);
    const states = slideAttrs(fake)
      .slice(-3)
      .map((call) => call[1]);
    expect(states).toEqual(["past", "past", "current"]);
  });

  it("should clean up attributes, pager, fullscreen and scroll back on exit", () => {
    const fake = createFakeHost();
    const { shell, log } = shellOf();
    const widget = mountOf(fake, shell);
    widget.update(presenting({ present: { active: true, page: 2 } }));
    widget.update(presenting({ present: { active: false, page: 2 } }));
    const lastStates = slideAttrs(fake)
      .slice(-3)
      .map((call) => call[1]);
    expect(lastStates).toEqual(["<removed>", "<removed>", "<removed>"]);
    expect(log.exits).toHaveLength(1);
    expect(log.writes.at(-1)).toBe("");
    expect(
      fake.calls.some(
        (call) => call.op === "scrollTo" && call.args[0] === `${ROOT} [data-hr-id="hr-c"]`,
      ),
    ).toBe(true);
    const presentAttrs = fake.calls.filter(
      (call) => call.op === "attr" && call.args[0] === ROOT && call.args[1] === "data-hr-present",
    );
    expect(presentAttrs.at(-1)?.args[2]).toBe("<removed>");
  });

  it("should degrade without a fullscreen implementation", () => {
    const fake = createFakeHost();
    const { shell } = shellOf();
    const widget = mountOf(fake, { hash: shell.hash });
    widget.update(presenting({ present: { active: true, page: 0 } }));
    widget.update(presenting({ present: { active: false, page: 0 } }));
    expect(slideAttrs(fake).length).toBeGreaterThan(0);
  });
});

describe("present · 页内步进", () => {
  it("should reveal steps before turning the page", () => {
    const fake = createFakeHost();
    const steps = [fakeElement("li"), fakeElement("li")];
    fake.all.set(stepSelector("hr-a"), steps);
    const widget = mountOf(fake, shellOf().shell);
    widget.update(presenting({ present: { active: true, page: 0 } }));
    expect(steps[0]?.getAttribute("data-hr-step-state")).toBe("future");
    expect(steps[1]?.getAttribute("data-hr-step-state")).toBe("future");
    expect(widget.before({ kind: "presentAdvanced" })).toBe(false);
    expect(steps[0]?.getAttribute("data-hr-step-state")).toBe("current");
    expect(steps[1]?.getAttribute("data-hr-step-state")).toBe("future");
    expect(widget.before({ kind: "presentAdvanced" })).toBe(false);
    expect(steps[0]?.getAttribute("data-hr-step-state")).toBe("past");
    expect(steps[1]?.getAttribute("data-hr-step-state")).toBe("current");
    expect(widget.before({ kind: "presentAdvanced" })).toBe(true);
  });

  it("should pass through unrelated intents and advances while inactive", () => {
    const fake = createFakeHost();
    const widget = mountOf(fake, shellOf().shell);
    widget.update(stateOf());
    expect(widget.before({ kind: "move", delta: 1 })).toBe(true);
    expect(widget.before({ kind: "presentAdvanced" })).toBe(true);
  });

  it("should restore per-page step progress when revisiting a page", () => {
    const fake = createFakeHost();
    const stepsA = [fakeElement("li")];
    const stepsB = [fakeElement("li")];
    fake.all.set(stepSelector("hr-a"), stepsA);
    fake.all.set(stepSelector("hr-b"), stepsB);
    const widget = mountOf(fake, shellOf().shell);
    widget.update(presenting({ present: { active: true, page: 0 } }));
    widget.before({ kind: "presentAdvanced" });
    widget.update(presenting({ present: { active: true, page: 1 } }));
    expect(stepsB[0]?.getAttribute("data-hr-step-state")).toBe("future");
    widget.update(presenting({ present: { active: true, page: 0 } }));
    expect(stepsA[0]?.getAttribute("data-hr-step-state")).toBe("current");
  });

  it("should clear step progress when the document changes mid-presentation", () => {
    const fake = createFakeHost();
    const steps = [fakeElement("li")];
    fake.all.set(stepSelector("hr-a"), steps);
    const widget = mountOf(fake, shellOf().shell);
    widget.update(presenting({ present: { active: true, page: 0 } }));
    widget.before({ kind: "presentAdvanced" });
    widget.update(
      presenting({ present: { active: true, page: 0 }, documentHtml: `${SLIDES_HTML}x` }),
    );
    expect(steps[0]?.getAttribute("data-hr-step-state")).toBe("future");
  });

  it("should strip step states on exit", () => {
    const fake = createFakeHost();
    const steps = [fakeElement("li")];
    fake.all.set(stepSelector("hr-a"), steps);
    const widget = mountOf(fake, shellOf().shell);
    widget.update(presenting({ present: { active: true, page: 0 } }));
    widget.before({ kind: "presentAdvanced" });
    widget.update(presenting({ present: { active: false, page: 0 } }));
    expect(steps[0]?.getAttribute("data-hr-step-state")).toBeNull();
  });
});

describe("present · hash 续页与全屏退出", () => {
  it("should jump to the hashed page on entry instead of painting the wrong one", () => {
    const fake = createFakeHost();
    const { shell, log } = shellOf({ hash: "p=3" });
    const intents: ReaderIntent[] = [];
    const widget = mountOf(fake, shell, intents);
    widget.update(presenting({ present: { active: true, page: 0 } }));
    expect(intents).toEqual([{ kind: "presentMoved", page: 2 }]);
    // 跳页意图由重入的那帧绘制，本帧不许先画错的一页。
    expect(slideAttrs(fake)).toHaveLength(0);
    widget.update(presenting({ present: { active: true, page: 2 } }));
    expect(log.enters).toHaveLength(1);
  });

  it("should auto-enter on boot when the hash names a page, exactly once", () => {
    const fake = createFakeHost();
    const { shell } = shellOf({ hash: "p=2" });
    const intents: ReaderIntent[] = [];
    const widget = mountOf(fake, shell, intents);
    widget.update(stateOf());
    expect(intents).toEqual([{ kind: "presentEntered", page: 1 }]);
    widget.update(presenting({ present: { active: true, page: 1 } }));
    widget.update(presenting({ present: { active: false, page: 1 } }));
    widget.update(stateOf());
    expect(intents).toEqual([{ kind: "presentEntered", page: 1 }]);
  });

  it("should not auto-enter without a page hash or when the hash is malformed", () => {
    const fake = createFakeHost();
    const intents: ReaderIntent[] = [];
    const { shell } = shellOf({ hash: "p=0" });
    const widget = mountOf(fake, shell, intents);
    widget.update(stateOf());
    expect(intents).toEqual([]);
    const { shell: shell2 } = shellOf({ hash: "p=x" });
    const intents2: ReaderIntent[] = [];
    mountOf(fake, shell2, intents2).update(stateOf());
    expect(intents2).toEqual([]);
  });

  it("should preserve other hash params while tracking the page", () => {
    const fake = createFakeHost();
    const { shell, log } = shellOf({ hash: "foo=1" });
    const widget = mountOf(fake, shell);
    widget.update(presenting({ present: { active: true, page: 0 } }));
    widget.update(presenting({ present: { active: true, page: 1 } }));
    expect(log.writes.at(-1)).toBe("p=2&foo=1");
    widget.update(presenting({ present: { active: false, page: 1 } }));
    expect(log.writes.at(-1)).toBe("foo=1");
  });

  it("should exit present when native fullscreen is dropped outside our control", () => {
    const fake = createFakeHost();
    const { shell, log, fireFsChange } = shellOf();
    const intents: ReaderIntent[] = [];
    const widget = mountOf(fake, shell, intents);
    widget.update(presenting({ present: { active: true, page: 0 } }));
    log.inFs = false;
    fireFsChange();
    expect(intents).toEqual([{ kind: "presentExited" }]);
  });

  it("should ignore fullscreenchange while entering or never having entered", () => {
    const fake = createFakeHost();
    const { shell, fireFsChange } = shellOf();
    const intents: ReaderIntent[] = [];
    const widget = mountOf(fake, shell, intents);
    fireFsChange();
    widget.update(presenting({ present: { active: true, page: 0 } }));
    fireFsChange();
    expect(intents).toEqual([]);
  });

  it("should treat a missing isFullscreen probe as dropped fullscreen", () => {
    const fake = createFakeHost();
    const { shell } = shellOf();
    const intents: ReaderIntent[] = [];
    let fire: (() => void) | undefined;
    const widget = mountPresent({
      host: fake.host,
      parent: ROOT,
      shell: {
        fullscreen: shell.fullscreen,
        onFullscreenChange: (handler) => {
          fire = handler;
          return () => undefined;
        },
      },
      onIntent: (intent) => {
        intents.push(intent);
      },
    });
    widget.update(presenting({ present: { active: true, page: 0 } }));
    fire?.();
    expect(intents).toEqual([{ kind: "presentExited" }]);
  });
});

describe("present · 边界", () => {
  it("should paint an empty step list when the active page id is missing", () => {
    const fake = createFakeHost();
    const widget = mountOf(fake, shellOf().shell);
    widget.update(presenting({ present: { active: true, page: 0 }, pages: [] }));
    expect(
      fake.calls.some((call) => call.op === "all" && call.args[0]?.includes("[data-hr-step]")),
    ).toBe(false);
  });

  it("should exit cleanly when the last page list is empty", () => {
    const fake = createFakeHost();
    const widget = mountOf(fake, shellOf().shell);
    widget.update(presenting({ present: { active: true, page: 0 }, pages: [] }));
    widget.update(presenting({ present: { active: false, page: 0 }, pages: [] }));
    expect(fake.ops()).not.toContain("scrollTo");
  });
});

describe("present · 演讲者备注", () => {
  const styles = readFileSync(join(import.meta.dirname, "..", "static/styles.css"), "utf8");

  it("should hide deep-dive components while presenting", () => {
    expect(styles).toContain('#hr-root[data-hr-present] [data-hr-component="deep-dive"]');
  });
});

describe("present · boot 接线", () => {
  const modelOf = (children: readonly { id?: string; tag?: string }[]) => () =>
    Promise.resolve({ revision: "r1", model: { children } });

  it("should derive pages from top-level h1 and sections", async () => {
    const h = harnessOf(true);
    boot({
      ...h.deps,
      fetchModel: modelOf([
        { id: "t", tag: "h1" },
        { id: "s1", tag: "section" },
        { id: "x", tag: "p" },
        { tag: "section" },
        { id: "s2", tag: "section" },
      ]),
    });
    await flush();
    expect(h.store.get().pages).toEqual(["t", "s1", "s2"]);
  });

  it("should fall back to all top-level blocks when no section exists", async () => {
    const h = harnessOf(true);
    boot({
      ...h.deps,
      fetchModel: modelOf([
        { id: "t", tag: "h1" },
        { id: "p1", tag: "p" },
      ]),
    });
    await flush();
    expect(h.store.get().pages).toEqual(["t", "p1"]);
  });

  it("should let a step swallow the advance instead of turning the page", async () => {
    const h = harnessOf(true);
    const steps = [fakeElement("li")];
    h.fake.all.set(stepSelector("hr-a"), steps);
    boot({
      ...h.deps,
      fetchModel: modelOf([
        { id: "hr-a", tag: "section" },
        { id: "hr-b", tag: "section" },
      ]),
    });
    await flush();
    h.type("p");
    expect(h.store.get().present).toEqual({ active: true, page: 0 });
    h.type("ArrowRight");
    expect(h.store.get().present.page).toBe(0);
    expect(steps[0]?.getAttribute("data-hr-step-state")).toBe("current");
    h.type("ArrowRight");
    expect(h.store.get().present.page).toBe(1);
  });

  it("should enter present mode from the keyboard and exit on Escape", async () => {
    const h = harnessOf(true);
    boot({
      ...h.deps,
      fetchModel: modelOf([
        { id: "hr-a", tag: "section" },
        { id: "hr-b", tag: "section" },
      ]),
    });
    await flush();
    h.type("p");
    expect(h.store.get().present.active).toBe(true);
    h.type("j");
    expect(h.store.get().activeId).toBe("hr-a");
    h.type("Escape");
    expect(h.store.get().present.active).toBe(false);
  });

  it("should preventDefault consumed keys so space and F5 stay in the page", () => {
    const h = harnessOf(true);
    boot(h.deps);
    const prevented = vi.fn();
    h.keyHandlers[0]?.({ key: "j", preventDefault: prevented });
    expect(prevented).toHaveBeenCalledTimes(1);
    const skipped = vi.fn();
    h.keyHandlers[0]?.({ key: "x", preventDefault: skipped });
    expect(skipped).not.toHaveBeenCalled();
  });
});
