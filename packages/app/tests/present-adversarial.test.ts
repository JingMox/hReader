// 这层管：演示模式的对抗面——hash 续页的真实启动顺序、`#p=` 的各种取值、
// 手动改 hash、退出时非当前页残留的步进属性、演示中途文档收缩/清空。

import { describe, expect, it } from "vitest";

import { boot } from "../src/boot.ts";
import { createStore } from "../src/store.ts";
import type { ReaderIntent, ReaderState } from "../src/state.ts";
import { mountPresent, type PresentShell } from "../src/widgets/present.ts";
import { flush, harnessOf } from "./support/boot-harness.ts";
import { fakeElement, type FakeElement } from "./support/fake-dom.ts";
import { createFakeHost, stateOf, type FakeHost } from "./support/fake-host.ts";

const ROOT = "#hr-root";
const SLIDES_HTML = '<article data-hr-kind="slides"><h1>t</h1><section>s</section></article>';

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

const shellOf = (init: { readonly hash?: string } = {}): {
  readonly shell: PresentShell;
  readonly log: ShellLog;
} => {
  const log: ShellLog = {
    enters: [],
    exits: [],
    writes: [],
    hash: init.hash ?? "",
    inFs: false,
  };
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
      hash: {
        read: () => log.hash,
        write: (hash) => {
          log.writes.push(hash);
          log.hash = hash;
        },
      },
    },
    log,
  };
};

const mountOf = (fake: FakeHost, shell: PresentShell, intents: ReaderIntent[] = []) =>
  mountPresent({
    host: fake.host,
    parent: ROOT,
    shell,
    onIntent: (intent) => {
      intents.push(intent);
    },
  });

const stepSelector = (id: string): string => `${ROOT} [data-hr-id="${id}"] [data-hr-step]`;

describe("present · hash 续页的真实启动顺序", () => {
  it("should still resume once pages arrive after the first accounting frame", () => {
    const fake = createFakeHost();
    const { shell } = shellOf({ hash: "p=2" });
    const store = createStore(stateOf());
    const widget = mountPresent({
      host: fake.host,
      parent: ROOT,
      shell,
      onIntent: (intent) => {
        store.dispatch(intent);
      },
    });
    store.subscribe(widget.update);

    // 真实 boot 顺序：startFlows 的记账帧先到（pages 还没回来），hydrate 才带页表。
    store.dispatch({ kind: "blocksLoaded", blocks: ["hr-a"], outline: [], html: "x" });
    store.dispatch({
      kind: "blocksLoaded",
      blocks: ["hr-a", "hr-b", "hr-c"],
      outline: [],
      pages: ["hr-a", "hr-b", "hr-c"],
    });

    expect(store.get().present).toEqual({ active: true, page: 1 });
  });

  it("should not consume the resume slot while a zero-page document stays unpresentable", () => {
    const fake = createFakeHost();
    const { shell } = shellOf({ hash: "p=2" });
    const intents: ReaderIntent[] = [];
    const widget = mountOf(fake, shell, intents);

    // 页表一直为空：续页意图此刻发了也会被 reduce 拒绝，widget 要等页表到了才发。
    widget.update(stateOf({ documentHtml: "x" }));
    widget.update(stateOf({ documentHtml: "x" }));
    expect(intents).toEqual([]);
  });
});

describe("present · #p= 的取值边界", () => {
  const intentsOf = (hash: string): readonly ReaderIntent[] => {
    const fake = createFakeHost();
    const { shell } = shellOf({ hash });
    const intents: ReaderIntent[] = [];
    mountOf(fake, shell, intents).update(stateOf({ pages: ["a", "b", "c"] }));
    return intents;
  };

  it.each([
    ["p=-3", []],
    ["p=0", []],
    ["p=abc", []],
    ["p=", []],
    ["p=x2", []],
    ["p=0x10", []],
    ["pp=2", []],
    ["P=2", []],
    ["p=1.9", [{ kind: "presentEntered", page: 0 }]],
    ["p= 2", [{ kind: "presentEntered", page: 1 }]],
    ["p=02", [{ kind: "presentEntered", page: 1 }]],
    ["foo&p=2", [{ kind: "presentEntered", page: 1 }]],
    ["&p=2", [{ kind: "presentEntered", page: 1 }]],
    ["p=2&p=5", [{ kind: "presentEntered", page: 1 }]],
    ["p=99", [{ kind: "presentEntered", page: 98 }]],
  ])("should map hash %j to intents %j", (hash, expected) => {
    expect(intentsOf(hash)).toEqual(expected);
  });
});

describe("present · 手动改 hash", () => {
  it("should overwrite a manually edited hash on the next turn instead of honoring it", () => {
    const fake = createFakeHost();
    const { shell, log } = shellOf();
    const widget = mountOf(fake, shell);
    widget.update(presenting({ present: { active: true, page: 0 } }));

    // 用户手动把地址栏改成 #p=3：没有 hashchange 监听，下一次翻页写回真实页码。
    log.hash = "p=3";
    widget.update(presenting({ present: { active: true, page: 1 } }));

    expect(log.writes.at(-1)).toBe("p=2");
    expect(log.hash).toBe("p=2");
  });
});

describe("present · 退出时的步进清理", () => {
  it("should strip step states on every visited page, not only the last one", () => {
    const fake = createFakeHost();
    const stepsA: FakeElement[] = [fakeElement("li")];
    const stepsB: FakeElement[] = [fakeElement("li")];
    fake.all.set(stepSelector("hr-a"), stepsA);
    fake.all.set(stepSelector("hr-b"), stepsB);
    const widget = mountOf(fake, shellOf().shell);

    widget.update(presenting({ present: { active: true, page: 0 } }));
    widget.before({ kind: "presentAdvanced" });
    widget.update(presenting({ present: { active: true, page: 1 } }));
    widget.update(presenting({ present: { active: false, page: 1 } }));

    expect(stepsA[0]?.getAttribute("data-hr-step-state")).toBeNull();
    expect(stepsB[0]?.getAttribute("data-hr-step-state")).toBeNull();
  });
});

describe("present · 演示中途文档收缩", () => {
  it("should clamp the page instead of leaving every slide marked past", () => {
    const fake = createFakeHost();
    const widget = mountOf(fake, shellOf().shell);
    const store = createStore(presenting({ present: { active: true, page: 2 } }));
    store.subscribe(widget.update);
    widget.update(store.get());

    // 外部把三节文档改成一节：页码必须收进新页表，不能停在空无一页的位置。
    store.dispatch({ kind: "blocksLoaded", blocks: ["hr-a"], outline: [], pages: ["hr-a"] });

    expect(store.get().present).toEqual({ active: true, page: 0 });
    const states = fake.calls
      .filter((call) => call.op === "attr" && call.args[1] === "data-hr-slide-state")
      .map((call) => [call.args[0], call.args[2]]);
    expect(states.at(-1)).toEqual([`${ROOT} [data-hr-id="hr-a"]`, "current"]);
  });

  it("should exit present mode when the reloaded document has no pages at all", () => {
    const fake = createFakeHost();
    const widget = mountOf(fake, shellOf().shell);
    const store = createStore(presenting({ present: { active: true, page: 0 } }));
    store.subscribe(widget.update);
    widget.update(store.get());

    store.dispatch({ kind: "blocksLoaded", blocks: [], outline: [], pages: [] });

    expect(store.get().present.active).toBe(false);
  });
});

describe("present · 非 slides 文档与外来文档", () => {
  it("should mark data-hr-present=document for a non-slides managed document", () => {
    const fake = createFakeHost();
    const widget = mountOf(fake, shellOf().shell);
    widget.update(
      stateOf({
        pages: ["hr-a", "hr-b"],
        present: { active: true, page: 0 },
        documentHtml: '<article data-hr-kind="note"><p>x</p></article>',
      }),
    );
    const attrs = fake.calls.filter(
      (call) => call.op === "attr" && call.args[0] === ROOT && call.args[1] === "data-hr-present",
    );
    expect(attrs.at(-1)?.args[2]).toBe("document");
  });

  it("should refuse present intents for a foreign document (no pages, no key wiring)", () => {
    const store = createStore(stateOf());
    const before = store.get();
    store.dispatch({ kind: "presentEntered" });
    store.dispatch({ kind: "presentAdvanced" });
    expect(store.get()).toBe(before);
  });
});

describe("present · 超快连按与边界页", () => {
  it("should stay clamped at the last page under a rapid key burst", async () => {
    const h = harnessOf(true);
    boot({
      ...h.deps,
      fetchModel: () =>
        Promise.resolve({
          revision: "r1",
          model: {
            children: [
              { id: "hr-a", tag: "section" },
              { id: "hr-b", tag: "section" },
            ],
          },
        }),
    });
    await flush();
    h.type("p");
    for (let i = 0; i < 8; i += 1) h.type("ArrowRight");
    expect(h.store.get().present).toEqual({ active: true, page: 1 });
    for (let i = 0; i < 8; i += 1) h.type("ArrowLeft");
    expect(h.store.get().present).toEqual({ active: true, page: 0 });
  });
});
