// 这层管：foreign widget（iframe 承载 + 信任横幅）的调用序列契约——
// sandbox 档位、横幅文案、动作按钮、写请求的成/败两面，全部在 `Host` 调用序列上断言。

import { describe, expect, it } from "vitest";

import { mountForeign, type ForeignDeps, type TrustLevel } from "../src/widgets/foreign.ts";
import { COPY } from "../src/widgets/copy.ts";
import { flush } from "./support/boot-harness.ts";
import { createFakeHost, type FakeHost } from "./support/fake-host.ts";

const ROOT = "#hr-root";
const BANNER = `${ROOT} #hr-foreign`;
const TEXT = `${ROOT} #hr-foreign-text`;
const ACTION = `${ROOT} #hr-foreign-action`;
const ERROR = `${ROOT} #hr-foreign-error`;
const FRAME = `${ROOT} #hr-foreign-frame`;

/** 沙箱的允许项黑名单：任何状态下出现其中任何一个，这条测试就该红。 */
const FORBIDDEN = /allow-same-origin|allow-popups|allow-modals|allow-top-navigation|allow-forms/;

const attrsOf = (fake: FakeHost, selector: string, name: string): readonly string[] =>
  fake.calls
    .filter((call) => call.op === "attr" && call.args[0] === selector && call.args[1] === name)
    .map((call) => call.args[2] ?? "");

const lastText = (fake: FakeHost, selector: string): string | undefined =>
  fake.calls
    .filter((call) => call.op === "text" && call.args[0] === selector)
    .map((call) => call.args[1] ?? "")
    .at(-1);

const depsOf = (fake: FakeHost, over: Partial<ForeignDeps> = {}): ForeignDeps => ({
  host: fake.host,
  parent: ROOT,
  docId: "外 文档.html",
  info: { cls: "foreign", trust: "off", scripts: true },
  setTrust: (level) => Promise.resolve(level),
  normalize: () => Promise.resolve(),
  theme: undefined,
  ...over,
});

describe("foreign · 挂载与横幅", () => {
  it("should mount a fully sandboxed iframe and the readonly banner for trust=off", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake));

    // docId 里的空格与多字节字符必须走百分号编码——iframe src 是 URL，不是选择器。
    expect(attrsOf(fake, FRAME, "src")).toEqual(["/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html"]);
    expect(attrsOf(fake, FRAME, "sandbox")).toEqual([""]);
    expect(attrsOf(fake, FRAME, "hidden")).toEqual(["<removed>"]);
    expect(attrsOf(fake, FRAME, "title")).toEqual([COPY.foreignFrameTitle]);
    expect(attrsOf(fake, ROOT, "data-hr-doc")).toEqual(["framed"]);
    expect(attrsOf(fake, BANNER, "hidden")).toEqual(["<removed>"]);

    const banner = lastText(fake, TEXT);
    expect(banner).toContain(COPY.foreignReadonly);
    expect(banner).toContain(COPY.foreignNoEdit);
    expect(banner).toContain(COPY.foreignScriptsOff);
    expect(lastText(fake, ACTION)).toBe(COPY.foreignAllow);
  });

  it("should mount allow-scripts with the disable action for trust=local", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { info: { cls: "foreign", trust: "local", scripts: true } }));

    expect(attrsOf(fake, FRAME, "sandbox")).toEqual(["allow-scripts"]);
    expect(lastText(fake, TEXT)).toContain(COPY.foreignScriptsOn);
    expect(lastText(fake, ACTION)).toBe(COPY.foreignDisallow);
  });

  it("should show only the readonly notice and no action when the page has no scripts", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { info: { cls: "foreign", trust: "off", scripts: false } }));

    const banner = lastText(fake, TEXT);
    expect(banner).toContain(COPY.foreignReadonly);
    expect(banner).not.toContain(COPY.foreignScriptsOff);
    expect(attrsOf(fake, ACTION, "hidden")).toEqual([""]);
    expect(lastText(fake, ACTION)).toBeUndefined();
  });

  it("should show the normalize banner and action for a normalizable document", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { info: { cls: "normalizable", trust: "off", scripts: false } }));

    expect(lastText(fake, TEXT)).toBe(COPY.normalizableBanner);
    expect(lastText(fake, ACTION)).toBe(COPY.normalizableAction);
  });
});

describe("foreign · sandbox 不变量", () => {
  it("should never combine allow-scripts with the escaping flags across all states", async () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake));

    // off → local → off 三个状态的 sandbox 值逐一钉住。
    fake.fire(ACTION, "click", {});
    await flush();
    fake.fire(ACTION, "click", {});
    await flush();

    const sandboxes = attrsOf(fake, FRAME, "sandbox");
    expect(sandboxes).toEqual(["", "allow-scripts", ""]);
    for (const value of sandboxes) expect(value).not.toMatch(FORBIDDEN);
  });
});

describe("foreign · 信任开关", () => {
  it("should re-sandbox and reload the iframe after a successful trust POST", async () => {
    const fake = createFakeHost();
    const asked: string[] = [];
    mountForeign(
      depsOf(fake, {
        setTrust: (level) => {
          asked.push(level);
          return Promise.resolve(level);
        },
      }),
    );

    fake.fire(ACTION, "click", {});
    await flush();

    expect(asked).toEqual(["local"]);
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("allow-scripts");
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html?r=n1");
    expect(lastText(fake, TEXT)).toContain(COPY.foreignScriptsOn);
    expect(lastText(fake, ACTION)).toBe(COPY.foreignDisallow);
  });

  it("should apply the server-confirmed level rather than the requested one", async () => {
    const fake = createFakeHost();
    // 服务端把请求钳回 off：UI 必须以确认值为准，不能乐观切换。
    mountForeign(depsOf(fake, { setTrust: () => Promise.resolve("off") }));

    fake.fire(ACTION, "click", {});
    await flush();

    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("");
  });

  it("should surface a failed trust POST in the banner and keep the current level", async () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { setTrust: () => Promise.reject(new Error("信任档写入失败")) }));

    fake.fire(ACTION, "click", {});
    await flush();

    expect(lastText(fake, ERROR)).toBe("信任档写入失败");
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("");
  });

  it("should stringify a non-Error rejection instead of crashing", async () => {
    const fake = createFakeHost();
    const cause: unknown = "boom";
    mountForeign(
      depsOf(fake, {
        setTrust: () =>
          Promise.resolve().then((): TrustLevel => {
            throw cause;
          }),
      }),
    );

    fake.fire(ACTION, "click", {});
    await flush();

    expect(lastText(fake, ERROR)).toBe("boom");
  });

  it("should clear the previous error before issuing a new write", async () => {
    const fake = createFakeHost();
    let attempt = 0;
    mountForeign(
      depsOf(fake, {
        setTrust: (level) => {
          attempt += 1;
          return attempt === 1 ? Promise.reject(new Error("先失败")) : Promise.resolve(level);
        },
      }),
    );

    fake.fire(ACTION, "click", {});
    await flush();
    fake.fire(ACTION, "click", {});
    await flush();

    // 第二次点击先把错误清空，成功后再重画：错误不会残留到成功态。
    const errors = fake.calls
      .filter((call) => call.op === "text" && call.args[0] === ERROR)
      .map((call) => call.args[1]);
    expect(errors).toEqual(["", "先失败", ""]);
    expect(lastText(fake, TEXT)).toContain(COPY.foreignScriptsOn);
  });

  it("should ignore a second click while a write is in flight", async () => {
    const fake = createFakeHost();
    const asked: string[] = [];
    let release: (value: "off" | "local") => void = () => undefined;
    mountForeign(
      depsOf(fake, {
        setTrust: (level) => {
          asked.push(level);
          return new Promise<"off" | "local">((resolve) => {
            release = resolve;
          });
        },
      }),
    );

    fake.fire(ACTION, "click", {});
    fake.fire(ACTION, "click", {});
    expect(asked).toEqual(["local"]);

    release("local");
    await flush();
    fake.fire(ACTION, "click", {});
    await flush();
    expect(asked).toEqual(["local", "off"]);
  });
});

describe("foreign · normalize 与刷新", () => {
  it("should call normalize on the action click and surface its failure", async () => {
    const fake = createFakeHost();
    let calls = 0;
    mountForeign(
      depsOf(fake, {
        info: { cls: "normalizable", trust: "off", scripts: false },
        normalize: () => {
          calls += 1;
          return Promise.reject(new Error("规范化失败：锁定中"));
        },
      }),
    );

    fake.fire(ACTION, "click", {});
    await flush();

    expect(calls).toBe(1);
    expect(lastText(fake, ERROR)).toBe("规范化失败：锁定中");
  });

  it("should reload the iframe with the event revision or a counter", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    handle.refresh("r9");
    handle.refresh();
    handle.refresh();

    expect(attrsOf(fake, FRAME, "src")).toEqual([
      "/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html",
      "/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html?r=r9",
      "/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html?r=n1",
      "/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html?r=n2",
    ]);
  });
});

describe("foreign · destroy", () => {
  it("should unbind the action, blank the frame and hand the chrome back", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    handle.destroy();

    expect(fake.listeners()).toEqual([]);
    expect(attrsOf(fake, ROOT, "data-hr-doc").at(-1)).toBe("<removed>");
    expect(attrsOf(fake, BANNER, "hidden").at(-1)).toBe("");
    expect(attrsOf(fake, FRAME, "hidden").at(-1)).toBe("");
    // allow-scripts 档的脚本只有换源才停：撤 src 比摘 iframe 更彻底。
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("about:blank");
  });

  it("should swallow a trust write that lands after destroy instead of resurrecting the frame", async () => {
    const fake = createFakeHost();
    let release: (value: "off" | "local") => void = () => undefined;
    const handle = mountForeign(
      depsOf(fake, {
        setTrust: () =>
          new Promise<"off" | "local">((resolve) => {
            release = resolve;
          }),
      }),
    );

    fake.fire(ACTION, "click", {});
    handle.destroy();

    // 用户点了"允许脚本"又立刻切走：promise 落地时外壳已归还，横幅不能复活、src 不能回写。
    release("local");
    await flush();

    expect(attrsOf(fake, BANNER, "hidden").at(-1)).toBe("");
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("about:blank");
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("");
  });

  it("should swallow a normalize failure that lands after destroy", async () => {
    const fake = createFakeHost();
    let reject: (cause: unknown) => void = () => undefined;
    const handle = mountForeign(
      depsOf(fake, {
        info: { cls: "normalizable", trust: "off", scripts: false },
        normalize: () =>
          new Promise<void>((_resolve, rej) => {
            reject = rej;
          }),
      }),
    );

    fake.fire(ACTION, "click", {});
    handle.destroy();

    reject(new Error("迟到失败"));
    await flush();

    // 迟到的错误同样不许复活横幅——否则 managed 文档的壳上挂着外来横幅。
    expect(attrsOf(fake, BANNER, "hidden").at(-1)).toBe("");
    expect(lastText(fake, ERROR)).toBe("");
  });

  it("should swallow a trust rejection that lands after destroy", async () => {
    const fake = createFakeHost();
    let reject: (cause: unknown) => void = () => undefined;
    const handle = mountForeign(
      depsOf(fake, {
        setTrust: () =>
          new Promise<"off" | "local">((_resolve, rej) => {
            reject = rej;
          }),
      }),
    );

    fake.fire(ACTION, "click", {});
    handle.destroy();

    reject(new Error("迟到拒绝"));
    await flush();

    expect(attrsOf(fake, BANNER, "hidden").at(-1)).toBe("");
    expect(lastText(fake, ERROR)).toBe("");
  });

  it("should ignore a refresh that arrives after destroy", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    handle.destroy();
    handle.refresh("late");

    // 销毁后的事件（close 前挤进来的 doc.changed）不许回写 src。
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("about:blank");
  });

  it("should ignore a resync that lands after destroy", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    handle.destroy();
    handle.syncInfo({ cls: "foreign", trust: "local", scripts: true });

    // 销毁后到的 info 重拉（同步竞态里慢一拍的服务端应答）不许复活横幅或换沙箱档。
    expect(attrsOf(fake, BANNER, "hidden").at(-1)).toBe("");
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("about:blank");
  });

  it("should swallow a theme write that lands after destroy", async () => {
    const fake = createFakeHost();
    let release: () => void = () => undefined;
    const handle = mountForeign(
      depsOf(fake, {
        theme: {
          themes: ["atelier-editorial", "deck-noir"],
          current: "atelier-editorial",
          apply: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
      }),
    );

    fake.fire(`${ROOT} #hr-theme-select`, "change", { value: "deck-noir" });
    handle.destroy();

    release();
    await flush();

    // 换主题写到一半就切走：落地后不许再 reload iframe。
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("about:blank");
  });

  it("should swallow a theme rejection that lands after destroy", async () => {
    const fake = createFakeHost();
    let reject: (cause: unknown) => void = () => undefined;
    const handle = mountForeign(
      depsOf(fake, {
        theme: {
          themes: ["atelier-editorial", "deck-noir"],
          current: "atelier-editorial",
          apply: () =>
            new Promise((_resolve, rej) => {
              reject = rej;
            }),
        },
      }),
    );

    fake.fire(`${ROOT} #hr-theme-select`, "change", { value: "deck-noir" });
    handle.destroy();

    reject(new Error("迟到写失败"));
    await flush();

    // 迟到的失败不许回滚 select、不许把错误刷到 managed 壳的错误槽。
    expect(lastText(fake, ERROR)).toBe("");
  });
});
