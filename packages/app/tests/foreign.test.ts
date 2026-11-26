// 这层管：foreign widget（iframe 承载 + 信任横幅 + 底栏权限开关）的调用序列契约——
// sandbox 档位、横幅文案、动作按钮、两个权限开关、写请求的成/败两面，全部在 `Host` 调用序列上断言。

import { describe, expect, it } from "vitest";

import {
  mountForeign,
  type DocGate,
  type DocPermissions,
  type ForeignDeps,
  type PermissionPatch,
} from "../src/widgets/foreign.ts";
import { COPY } from "../src/widgets/copy.ts";
import { flush } from "./support/boot-harness.ts";
import { createFakeHost, type FakeHost } from "./support/fake-host.ts";

const ROOT = "#hr-root";
const BANNER = `${ROOT} #hr-foreign`;
const TEXT = `${ROOT} #hr-foreign-text`;
const ACTION = `${ROOT} #hr-foreign-action`;
const ERROR = `${ROOT} #hr-foreign-error`;
const FRAME = `${ROOT} #hr-foreign-frame`;
const PERMS = `${ROOT} #hr-perms`;
const PERM_SCRIPTS = `${ROOT} #hr-perm-scripts`;
const PERM_NETWORK = `${ROOT} #hr-perm-network`;

/** 沙箱的允许项黑名单：任何状态下出现其中任何一个，这条测试就该红。 */
const FORBIDDEN = /allow-same-origin|allow-popups|allow-modals|allow-top-navigation|allow-forms/;

/** 生效视图的常用夹具：两维全关、逐文档模式（开关可点）。 */
const permsOf = (over: Partial<DocPermissions> = {}): DocPermissions => ({
  scripts: false,
  network: false,
  scriptsSource: "doc",
  networkSource: "doc",
  modes: { scripts: "per-doc", network: "per-doc" },
  ...over,
});

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
  info: { cls: "foreign", scripts: true, permissions: permsOf() },
  setPermissions: (patch: PermissionPatch) => Promise.resolve({ ...permsOf(), ...patch }),
  normalize: () => Promise.resolve(),
  theme: undefined,
  ...over,
});

describe("foreign · 挂载与横幅", () => {
  it("should mount a fully sandboxed iframe, the readonly banner and the two toggles", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake));

    // docId 里的空格与多字节字符必须走百分号编码——iframe src 是 URL，不是选择器。
    expect(attrsOf(fake, FRAME, "src")).toEqual(["/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html"]);
    expect(attrsOf(fake, FRAME, "sandbox")).toEqual([""]);
    expect(attrsOf(fake, FRAME, "hidden")).toEqual(["<removed>"]);
    expect(attrsOf(fake, FRAME, "title")).toEqual([COPY.foreignFrameTitle]);
    expect(attrsOf(fake, FRAME, "allow")).toEqual(["fullscreen"]);
    expect(attrsOf(fake, ROOT, "data-hr-doc")).toEqual(["framed"]);
    expect(attrsOf(fake, BANNER, "hidden")).toEqual(["<removed>"]);

    const banner = lastText(fake, TEXT);
    expect(banner).toContain(COPY.foreignReadonly);
    expect(banner).toContain(COPY.foreignNoEdit);
    expect(banner).toContain(COPY.foreignScriptsOff);
    expect(lastText(fake, ACTION)).toBe(COPY.foreignAllow);

    // 底栏两个开关：按生效视图画关/开态与提示。
    expect(attrsOf(fake, PERMS, "hidden")).toEqual(["<removed>"]);
    expect(lastText(fake, PERM_SCRIPTS)).toBe("脚本：关");
    expect(lastText(fake, PERM_NETWORK)).toBe("联网：关");
    expect(attrsOf(fake, PERM_SCRIPTS, "data-on")).toEqual(["false"]);
    expect(attrsOf(fake, PERM_SCRIPTS, "aria-pressed")).toEqual(["false"]);
  });

  it("should mount allow-scripts with the disable action when scripts are effective", () => {
    const fake = createFakeHost();
    mountForeign(
      depsOf(fake, {
        info: { cls: "foreign", scripts: true, permissions: permsOf({ scripts: true }) },
      }),
    );

    expect(attrsOf(fake, FRAME, "sandbox")).toEqual(["allow-scripts"]);
    expect(lastText(fake, TEXT)).toContain(COPY.foreignScriptsOn);
    expect(lastText(fake, ACTION)).toBe(COPY.foreignDisallow);
    expect(lastText(fake, PERM_SCRIPTS)).toBe("脚本：开");
  });

  it("should mention the granted network dimension in the banner", () => {
    const fake = createFakeHost();
    mountForeign(
      depsOf(fake, {
        info: { cls: "foreign", scripts: true, permissions: permsOf({ network: true }) },
      }),
    );

    expect(lastText(fake, TEXT)).toContain(COPY.foreignNetworkOn);
    expect(lastText(fake, PERM_NETWORK)).toBe("联网：开");
    // 联网不收 sandbox——沙箱只管脚本，网络是服务端 CSP 的事。
    expect(attrsOf(fake, FRAME, "sandbox")).toEqual([""]);
  });

  it("should show only the readonly notice and no action when the page has no scripts", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { info: { cls: "foreign", scripts: false } }));

    const banner = lastText(fake, TEXT);
    expect(banner).toContain(COPY.foreignReadonly);
    expect(banner).not.toContain(COPY.foreignScriptsOff);
    expect(attrsOf(fake, ACTION, "hidden")).toEqual([""]);
    expect(lastText(fake, ACTION)).toBeUndefined();
  });

  it("should show the normalize banner/action and keep toggles hidden for normalizable docs", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { info: { cls: "normalizable", scripts: false } }));

    expect(lastText(fake, TEXT)).toBe(COPY.normalizableBanner);
    expect(lastText(fake, ACTION)).toBe(COPY.normalizableAction);
    expect(attrsOf(fake, PERMS, "hidden")).toEqual([""]);
  });

  it("should keep toggles hidden when the info carries no permissions view", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { info: { cls: "foreign", scripts: true } }));

    expect(attrsOf(fake, PERMS, "hidden")).toEqual([""]);
    expect(attrsOf(fake, FRAME, "sandbox")).toEqual([""]);
  });
});

describe("foreign · sandbox 不变量", () => {
  it("should never combine allow-scripts with the escaping flags across all states", async () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake));

    // off → on → off 三个状态的 sandbox 值逐一钉住。
    fake.fire(ACTION, "click", {});
    await flush();
    fake.fire(ACTION, "click", {});
    await flush();

    const sandboxes = attrsOf(fake, FRAME, "sandbox");
    expect(sandboxes).toEqual(["", "allow-scripts", ""]);
    for (const value of sandboxes) expect(value).not.toMatch(FORBIDDEN);
  });
});

describe("foreign · 权限开关", () => {
  it("should POST the scripts patch, re-sandbox and reload the iframe", async () => {
    const fake = createFakeHost();
    const asked: PermissionPatch[] = [];
    mountForeign(
      depsOf(fake, {
        setPermissions: (patch) => {
          asked.push(patch);
          return Promise.resolve(permsOf({ scripts: patch.scripts === true }));
        },
      }),
    );

    fake.fire(PERM_SCRIPTS, "click", {});
    await flush();

    expect(asked).toEqual([{ scripts: true }]);
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("allow-scripts");
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html?r=n1");
    expect(lastText(fake, TEXT)).toContain(COPY.foreignScriptsOn);
    expect(lastText(fake, ACTION)).toBe(COPY.foreignDisallow);
    expect(attrsOf(fake, PERM_SCRIPTS, "data-on").at(-1)).toBe("true");
  });

  it("should POST the network patch and reload without touching the sandbox", async () => {
    const fake = createFakeHost();
    const asked: PermissionPatch[] = [];
    mountForeign(
      depsOf(fake, {
        setPermissions: (patch) => {
          asked.push(patch);
          return Promise.resolve(permsOf({ network: patch.network === true }));
        },
      }),
    );

    fake.fire(PERM_NETWORK, "click", {});
    await flush();

    expect(asked).toEqual([{ network: true }]);
    // 生效组合变了要重载（CSP 换了），但 sandbox 维度不动。
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html?r=n1");
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("");
    expect(attrsOf(fake, PERM_NETWORK, "data-on").at(-1)).toBe("true");
  });

  it("should apply the server-confirmed effective view rather than the requested one", async () => {
    const fake = createFakeHost();
    // 服务端把请求钳回关（例如全局模式在写入瞬间变了）：UI 必须以确认值为准。
    mountForeign(depsOf(fake, { setPermissions: () => Promise.resolve(permsOf()) }));

    fake.fire(PERM_SCRIPTS, "click", {});
    await flush();

    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("");
    expect(attrsOf(fake, PERM_SCRIPTS, "data-on").at(-1)).toBe("false");
  });

  it("should surface a failed write in the banner and keep the current state", async () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake, { setPermissions: () => Promise.reject(new Error("权限写入失败")) }));

    fake.fire(PERM_SCRIPTS, "click", {});
    await flush();

    expect(lastText(fake, ERROR)).toBe("权限写入失败");
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("");
    expect(attrsOf(fake, PERM_SCRIPTS, "data-on").at(-1)).toBe("false");
  });

  it("should stringify a non-Error rejection instead of crashing", async () => {
    const fake = createFakeHost();
    const cause: unknown = "boom";
    mountForeign(
      depsOf(fake, {
        setPermissions: () =>
          Promise.resolve().then((): DocPermissions => {
            throw cause;
          }),
      }),
    );

    fake.fire(PERM_SCRIPTS, "click", {});
    await flush();

    expect(lastText(fake, ERROR)).toBe("boom");
  });

  it("should clear the previous error before issuing a new write", async () => {
    const fake = createFakeHost();
    let attempt = 0;
    mountForeign(
      depsOf(fake, {
        setPermissions: (patch) => {
          attempt += 1;
          return attempt === 1
            ? Promise.reject(new Error("先失败"))
            : Promise.resolve(permsOf({ scripts: patch.scripts === true }));
        },
      }),
    );

    fake.fire(PERM_SCRIPTS, "click", {});
    await flush();
    fake.fire(PERM_SCRIPTS, "click", {});
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
    const asked: PermissionPatch[] = [];
    let release: (value: DocPermissions) => void = () => undefined;
    mountForeign(
      depsOf(fake, {
        setPermissions: (patch) => {
          asked.push(patch);
          return new Promise<DocPermissions>((resolve) => {
            release = resolve;
          });
        },
      }),
    );

    fake.fire(PERM_SCRIPTS, "click", {});
    fake.fire(PERM_SCRIPTS, "click", {});
    fake.fire(PERM_NETWORK, "click", {});
    // 横幅动作位同样串行化：写请求在途时动作点击不能再发一份。
    fake.fire(ACTION, "click", {});
    expect(asked).toEqual([{ scripts: true }]);

    release(permsOf({ scripts: true }));
    await flush();
    fake.fire(PERM_NETWORK, "click", {});
    await flush();
    expect(asked).toEqual([{ scripts: true }, { network: true }]);
  });

  it("should drive the banner action through the same permissions write", async () => {
    const fake = createFakeHost();
    const asked: PermissionPatch[] = [];
    mountForeign(
      depsOf(fake, {
        setPermissions: (patch) => {
          asked.push(patch);
          return Promise.resolve(permsOf({ scripts: patch.scripts === true }));
        },
      }),
    );

    fake.fire(ACTION, "click", {});
    await flush();

    expect(asked).toEqual([{ scripts: true }]);
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("allow-scripts");
  });
});

describe("foreign · 全局模式接管", () => {
  const globallyAllowed = permsOf({
    scripts: true,
    scriptsSource: "global",
    modes: { scripts: "allow", network: "per-doc" },
  });

  it("should disable the controlled toggle with the unified-control hint", () => {
    const fake = createFakeHost();
    mountForeign(
      depsOf(fake, {
        info: { cls: "foreign", scripts: true, permissions: globallyAllowed },
      }),
    );

    // 开关显示的是"实际生效"（开），但不可点。
    expect(lastText(fake, PERM_SCRIPTS)).toBe("脚本：开");
    expect(attrsOf(fake, PERM_SCRIPTS, "disabled")).toEqual([""]);
    expect(attrsOf(fake, PERM_SCRIPTS, "title")).toEqual([COPY.permControlled]);
    // 未接管的另一维照常可点。
    expect(attrsOf(fake, PERM_NETWORK, "disabled")).toEqual(["<removed>"]);
    expect(attrsOf(fake, PERM_NETWORK, "title")).toEqual(["为本文档开启联网"]);
  });

  it("should ignore clicks on a globally controlled toggle", async () => {
    const fake = createFakeHost();
    const asked: PermissionPatch[] = [];
    mountForeign(
      depsOf(fake, {
        info: { cls: "foreign", scripts: true, permissions: globallyAllowed },
        setPermissions: (patch) => {
          asked.push(patch);
          return Promise.resolve(globallyAllowed);
        },
      }),
    );

    // 置灰是表现层；逻辑层同样拦住（绕过 disabled 的合成点击不能发出写请求）。
    fake.fire(PERM_SCRIPTS, "click", {});
    // 横幅动作位被隐藏但监听仍在：同样的逻辑层闸门，一样不许发写。
    fake.fire(ACTION, "click", {});
    await flush();

    expect(asked).toEqual([]);
  });

  it("should hide the banner action while scripts are globally controlled", () => {
    const fake = createFakeHost();
    mountForeign(
      depsOf(fake, {
        info: { cls: "foreign", scripts: true, permissions: globallyAllowed },
      }),
    );

    expect(attrsOf(fake, ACTION, "hidden").at(-1)).toBe("");
  });
});

describe("foreign · normalize 与刷新", () => {
  it("should call normalize on the action click and surface its failure", async () => {
    const fake = createFakeHost();
    let calls = 0;
    mountForeign(
      depsOf(fake, {
        info: { cls: "normalizable", scripts: false },
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

describe("foreign · syncInfo 对账", () => {
  it("should reload the iframe when the effective network flag changes too", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    handle.syncInfo({
      cls: "foreign",
      scripts: true,
      permissions: permsOf({ network: true }),
    });

    // sandbox 没变但 CSP 变了：生效组合变化就要重载。
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html?r=n1");
    expect(lastText(fake, TEXT)).toContain(COPY.foreignNetworkOn);
  });

  it("should repaint without reloading when the effective combination is unchanged", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    // 同一生效组合再报一次（比如 modes 重述）：不白白重载 iframe。
    handle.syncInfo({ cls: "foreign", scripts: true, permissions: permsOf() });

    expect(attrsOf(fake, FRAME, "src")).toEqual(["/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html"]);
  });

  it("should disable toggles in place when a resync reports global control", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    handle.syncInfo({
      cls: "foreign",
      scripts: true,
      permissions: permsOf({
        scriptsSource: "global",
        modes: { scripts: "deny", network: "per-doc" },
      }),
    });

    expect(attrsOf(fake, PERM_SCRIPTS, "disabled").at(-1)).toBe("");
    expect(attrsOf(fake, PERM_SCRIPTS, "title").at(-1)).toBe(COPY.permControlled);
    // 全局 deny 下脚本不生效，开关文本也报关。
    expect(lastText(fake, PERM_SCRIPTS)).toBe("脚本：关");
  });
});

describe("foreign · destroy", () => {
  it("should unbind the action/toggles, blank the frame and hand the chrome back", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    handle.destroy();

    expect(fake.listeners()).toEqual([]);
    expect(attrsOf(fake, ROOT, "data-hr-doc").at(-1)).toBe("<removed>");
    expect(attrsOf(fake, BANNER, "hidden").at(-1)).toBe("");
    expect(attrsOf(fake, PERMS, "hidden").at(-1)).toBe("");
    expect(attrsOf(fake, FRAME, "hidden").at(-1)).toBe("");
    // allow-scripts 档的脚本只有换源才停：撤 src 比摘 iframe 更彻底。
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("about:blank");
  });

  it("should swallow a permissions write that lands after destroy", async () => {
    const fake = createFakeHost();
    let release: (value: DocPermissions) => void = () => undefined;
    const handle = mountForeign(
      depsOf(fake, {
        setPermissions: () =>
          new Promise<DocPermissions>((resolve) => {
            release = resolve;
          }),
      }),
    );

    fake.fire(PERM_SCRIPTS, "click", {});
    handle.destroy();

    // 用户点了开关又立刻切走：promise 落地时外壳已归还，开关与横幅不能复活、src 不能回写。
    release(permsOf({ scripts: true }));
    await flush();

    expect(attrsOf(fake, BANNER, "hidden").at(-1)).toBe("");
    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("about:blank");
    expect(attrsOf(fake, FRAME, "sandbox").at(-1)).toBe("");
    expect(attrsOf(fake, PERM_SCRIPTS, "data-on").at(-1)).toBe("false");
  });

  it("should swallow a normalize failure that lands after destroy", async () => {
    const fake = createFakeHost();
    let reject: (cause: unknown) => void = () => undefined;
    const handle = mountForeign(
      depsOf(fake, {
        info: { cls: "normalizable", scripts: false },
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

  it("should swallow a permissions rejection that lands after destroy", async () => {
    const fake = createFakeHost();
    let reject: (cause: unknown) => void = () => undefined;
    const handle = mountForeign(
      depsOf(fake, {
        setPermissions: () =>
          new Promise<DocPermissions>((_resolve, rej) => {
            reject = rej;
          }),
      }),
    );

    fake.fire(PERM_SCRIPTS, "click", {});
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
    handle.syncInfo({
      cls: "foreign",
      scripts: true,
      permissions: permsOf({ scripts: true }),
    });

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

describe("foreign · 自导航拦截", () => {
  it("should reset the frame to /s/ and flag the banner on an unmarked load with network off", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake));
    const docSrc = "/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html";

    // 首个 load 核销挂载时那次导航；再到的 load 就是文档自导航（meta refresh / target=_self / location=）。
    fake.fire(FRAME, "load", {});
    fake.fire(FRAME, "load", {});

    expect(attrsOf(fake, FRAME, "src")).toEqual([docSrc, docSrc]);
    expect(lastText(fake, ERROR)).toBe(COPY.foreignNavBlocked);
    expect(attrsOf(fake, BANNER, "hidden").at(-1)).toBe("<removed>");
  });

  it("should reset on every hostile load, not only the first", () => {
    const fake = createFakeHost();
    mountForeign(depsOf(fake));
    const docSrc = "/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html";

    fake.fire(FRAME, "load", {});
    fake.fire(FRAME, "load", {});
    fake.fire(FRAME, "load", {});
    fake.fire(FRAME, "load", {});

    // 复位写出的 src 也是自写导航：第二个 load 拦一次、第三个 load 核销复位、第四个再拦。
    expect(attrsOf(fake, FRAME, "src")).toEqual([docSrc, docSrc, docSrc]);
  });

  it("should let an unmarked load pass when the network dimension is on", () => {
    const fake = createFakeHost();
    mountForeign(
      depsOf(fake, {
        info: { cls: "foreign", scripts: true, permissions: permsOf({ network: true }) },
      }),
    );

    fake.fire(FRAME, "load", {});
    fake.fire(FRAME, "load", {});

    // 联网是全包：框架内导航是授权语义的一部分，不回写 src、不报错。
    expect(attrsOf(fake, FRAME, "src")).toEqual(["/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html"]);
    expect(lastText(fake, ERROR)).toBeUndefined();
  });

  it("should consume our own refresh without flagging it", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));
    const docSrc = "/s/%E5%A4%96%20%E6%96%87%E6%A1%A3.html";

    fake.fire(FRAME, "load", {});
    handle.refresh("rev9");
    fake.fire(FRAME, "load", {});

    // refresh 的 load 是自己发起的：核销后无复位、无提示。
    expect(attrsOf(fake, FRAME, "src")).toEqual([docSrc, `${docSrc}?r=rev9`]);
    expect(lastText(fake, ERROR)).toBeUndefined();
  });

  it("should ignore a load that lands after destroy", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    handle.destroy();
    fake.fire(FRAME, "load", {});

    expect(attrsOf(fake, FRAME, "src").at(-1)).toBe("about:blank");
    expect(lastText(fake, ERROR)).toBeUndefined();
  });
});

describe("foreign · 壳层门栏上报", () => {
  it("should report the foreign gate with the effective network state on mount", () => {
    const fake = createFakeHost();
    const gates: DocGate[] = [];
    mountForeign(depsOf(fake, { reportGate: (gate) => gates.push(gate) }));

    expect(gates).toEqual([{ docId: "外 文档.html", foreign: true, network: false }]);
  });

  it("should re-report the gate whenever syncInfo refreshes the effective view", () => {
    const fake = createFakeHost();
    const gates: DocGate[] = [];
    const handle = mountForeign(depsOf(fake, { reportGate: (gate) => gates.push(gate) }));

    handle.syncInfo({ cls: "foreign", scripts: true, permissions: permsOf({ network: true }) });

    expect(gates.at(-1)).toEqual({ docId: "外 文档.html", foreign: true, network: true });
  });

  it("should clear the gate on destroy so a following managed doc keeps open-external", () => {
    const fake = createFakeHost();
    const gates: DocGate[] = [];
    const handle = mountForeign(depsOf(fake, { reportGate: (gate) => gates.push(gate) }));

    handle.destroy();

    expect(gates.at(-1)).toEqual({ docId: "外 文档.html", foreign: false, network: false });
  });

  it("should stay silent when the embedding shell never provided a gate channel", () => {
    const fake = createFakeHost();
    const handle = mountForeign(depsOf(fake));

    // 无 reportGate 依赖：浏览器里这段代码不能炸。
    handle.syncInfo({ cls: "foreign", scripts: true, permissions: permsOf({ network: true }) });
    handle.destroy();
  });
});
