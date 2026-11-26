// 这层管：入口 `main` 的"info 先分档"端到端——
// foreign 只发 /info + /api/theme 就进 iframe 壳（正文与 model/outline 一概不拉），
// normalizable 一键规范化后重进 managed（那时才拉主题与正文）。

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Host } from "../src/dom.ts";
import type { AppIo } from "../src/main.ts";
import { REQUIRED_ANCHORS } from "../src/anchors.ts";
import { COPY } from "../src/widgets/copy.ts";
import { fakeElement, type FakeElement } from "./support/fake-dom.ts";
import { flush, happy, install, jsonOf, load, stubs } from "./support/main-stubs.ts";

const ROOT = "#hr-root";
const FRAME = `${ROOT} #hr-foreign-frame`;
const ACTION = `${ROOT} #hr-foreign-action`;
const ERROR = `${ROOT} #hr-foreign-error`;
const TEXT = `${ROOT} #hr-foreign-text`;
const PERMS = `${ROOT} #hr-perms`;
const PERM_SCRIPTS = `${ROOT} #hr-perm-scripts`;
const PERM_NETWORK = `${ROOT} #hr-perm-network`;

/** 外来壳碰到的每个选择器都登记一个假元素；带 `#hr-root` 前缀的选择器与裸 id 共用同一元素。 */
const installForeignDom = (): FakeElement => {
  const root = fakeElement("div");
  for (const id of REQUIRED_ANCHORS) {
    const element = id === ROOT ? root : fakeElement("div");
    stubs.doc.bySelector.set(id, element);
    if (id !== ROOT) stubs.doc.bySelector.set(`${ROOT} ${id}`, element);
  }
  return root;
};

const el = (selector: string): FakeElement | undefined => stubs.doc.bySelector.get(selector);

/** 外来文档的生效视图夹具：两维全关、逐文档模式（与 core 默认一致）。 */
const permsOff = {
  scripts: false,
  network: false,
  scriptsSource: "doc",
  networkSource: "doc",
  modes: { scripts: "per-doc", network: "per-doc" },
};
const foreignInfo = {
  revision: "r1",
  cls: "foreign",
  trust: "off",
  scripts: true,
  permissions: permsOff,
};
const normalizableInfo = { revision: "r1", cls: "normalizable" };

const foreignDoc =
  (payload: Readonly<Record<string, unknown>> = foreignInfo) =>
  (url: string): Response =>
    url.endsWith("/info") ? jsonOf(payload) : happy(url);

const requestBodies = (url: string): readonly Record<string, unknown>[] =>
  stubs.requests
    .filter((request) => request.method === "POST" && request.url === url)
    .map((request) => JSON.parse(String(request.body)) as Record<string, unknown>);

/** 最小记录 host：`text`/`on` 是断言面，其余 op 一律 no-op（`io` 无 `post` 的用例专用）。 */
const recordHostOf = (): {
  readonly texts: [string, string][];
  readonly host: Host;
  readonly fire: (selector: string) => void;
} => {
  const texts: [string, string][] = [];
  const handlers = new Map<string, (target: { value?: string }) => void>();
  const noop = (): void => undefined;
  return {
    texts,
    host: {
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
        return noop;
      },
      scrollTo: noop,
      all: () => [],
      destroy: noop,
    },
    fire: (selector) => {
      handlers.get(`${selector}|click`)?.({});
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("main · 外来文档首屏", () => {
  it("should mount the sandboxed iframe with only the info request", async () => {
    install("doc.html", "http://x/", foreignDoc());
    const root = installForeignDom();
    await load();

    // 分流的硬边界：iframe 自己加载 /s/，阅读器只多拿主题清单（下拉要画选项），
    // 正文与 model/outline 一概不拉。
    expect(stubs.fetched).toEqual(["/api/doc/doc.html/info", "/api/theme"]);

    const frame = el(FRAME);
    expect(root.attrs.get("data-hr-doc")).toBe("framed");
    expect(frame?.attrs.get("src")).toBe("/s/doc.html");
    expect(frame?.attrs.get("sandbox")).toBe("");
    expect(frame?.attrs.get("referrerpolicy")).toBe("no-referrer");
    expect(frame?.attrs.has("hidden")).toBe(false);
    expect(el(TEXT)?.textContent).toContain(COPY.foreignReadonly);
    expect(el(TEXT)?.textContent).toContain(COPY.foreignNoEdit);
    expect(el(TEXT)?.textContent).toContain(COPY.foreignScriptsOff);
    expect(el(ACTION)?.textContent).toBe(COPY.foreignAllow);
    // 底栏两个权限开关：外来文档才挂出来。
    expect(el(PERMS)?.attrs.has("hidden")).toBe(false);
    expect(el(PERM_SCRIPTS)?.textContent).toBe("脚本：关");
    expect(el(PERM_NETWORK)?.textContent).toBe("联网：关");
  });

  it("should not blow up on mouseup since there is no selection surface", async () => {
    install("doc.html", "http://x/", foreignDoc());
    installForeignDom();
    await load();

    expect(stubs.mouseups).toHaveLength(1);
    expect(() => stubs.mouseups[0]?.()).not.toThrow();
  });
});

describe("main · 权限开关（POST /permissions）", () => {
  it("should POST the scripts patch, re-sandbox and reload the iframe", async () => {
    install("doc.html", "http://x/", (url) =>
      url.endsWith("/permissions")
        ? jsonOf({ permissions: { ...permsOff, scripts: true } })
        : foreignDoc()(url),
    );
    installForeignDom();
    await load();

    stubs.doc.fire(PERM_SCRIPTS, "click", {});
    await flush();

    expect(requestBodies("/api/doc/doc.html/permissions")).toEqual([{ scripts: true }]);
    const frame = el(FRAME);
    expect(frame?.attrs.get("sandbox")).toBe("allow-scripts");
    expect(frame?.attrs.get("src")).toBe("/s/doc.html?r=n1");
    expect(el(ACTION)?.textContent).toBe(COPY.foreignDisallow);
    expect(el(PERM_SCRIPTS)?.attrs.get("data-on")).toBe("true");
  });

  it("should POST the network patch through the same channel", async () => {
    install("doc.html", "http://x/", (url) =>
      url.endsWith("/permissions")
        ? jsonOf({ permissions: { ...permsOff, network: true } })
        : foreignDoc()(url),
    );
    installForeignDom();
    await load();

    stubs.doc.fire(PERM_NETWORK, "click", {});
    await flush();

    expect(requestBodies("/api/doc/doc.html/permissions")).toEqual([{ network: true }]);
    // 联网不收 sandbox，但生效组合变了必须重载（服务端 CSP 换了）。
    expect(el(FRAME)?.attrs.get("sandbox")).toBe("");
    expect(el(FRAME)?.attrs.get("src")).toBe("/s/doc.html?r=n1");
    expect(el(PERM_NETWORK)?.textContent).toBe("联网：开");
  });

  it("should surface a shape-mismatched permissions response in the banner", async () => {
    install("doc.html", "http://x/", (url) =>
      url.endsWith("/permissions")
        ? jsonOf({ permissions: { scripts: "bogus" } })
        : foreignDoc()(url),
    );
    installForeignDom();
    await load();

    stubs.doc.fire(PERM_SCRIPTS, "click", {});
    await flush();

    expect(el(ERROR)?.textContent).toBe("/api/doc/doc.html/permissions → 响应形状不符");
    expect(el(FRAME)?.attrs.get("sandbox")).toBe("");
  });

  it("should report a clear error when the injected io has no write channel", async () => {
    install("doc.html", "http://x/", foreignDoc());
    installForeignDom();
    const { bootDocumentWith } = await import("../src/main.ts");
    const { texts, host, fire } = recordHostOf();
    const io: AppIo = {
      text: () => Promise.resolve(""),
      json: (path, guard) => {
        const candidate: unknown = path.endsWith("/info")
          ? foreignInfo
          : path === "/api/theme"
            ? { themes: ["atelier-editorial"], default: "atelier-editorial" }
            : {};
        return guard(candidate)
          ? Promise.resolve(candidate)
          : Promise.reject(new Error(`${path} → 响应形状不符`));
      },
    };

    await bootDocumentWith({ docId: "doc.html", io, host });
    fire(ACTION);
    await flush();

    expect(texts.filter(([selector]) => selector === ERROR).at(-1)?.[1]).toBe(
      "当前 IO 未实现写请求（POST）",
    );
  });
});

describe("main · iframe 刷新与卸载", () => {
  it("should reload the iframe on a pushed doc.changed", async () => {
    install("doc.html", "http://x/", foreignDoc());
    installForeignDom();
    await load();

    const source = stubs.sources[0];
    source?.onopen?.();
    source?.fire("doc.changed", JSON.stringify({ revision: "r9" }), "1");

    expect(el(FRAME)?.attrs.get("src")).toBe("/s/doc.html?r=r9");
  });

  it("should blank the frame and restore the chrome on pagehide", async () => {
    install("doc.html", "http://x/", foreignDoc());
    const root = installForeignDom();
    await load();

    for (const handler of stubs.pagehide) handler({ key: "" });

    const frame = el(FRAME);
    expect(root.attrs.has("data-hr-doc")).toBe(false);
    expect(frame?.attrs.get("src")).toBe("about:blank");
    expect(frame?.attrs.get("hidden")).toBe("");
    expect(stubs.closed).toBe(1);
  });
});

describe("main · 一键规范化（POST /normalize）", () => {
  const normalizableFlow = (): ((url: string) => Response) => {
    let cls = "normalizable";
    return (url: string): Response => {
      if (url.endsWith("/info")) {
        return jsonOf(cls === "normalizable" ? normalizableInfo : { revision: "r2", cls });
      }
      if (url.endsWith("/normalize")) {
        cls = "managed";
        return jsonOf({ revision: "r2", cls: "managed" });
      }
      return happy(url);
    };
  };

  it("should re-boot as managed after a successful normalize", async () => {
    install("doc.html", "http://x/", normalizableFlow());
    installForeignDom();
    await load();

    expect(el(TEXT)?.textContent).toBe(COPY.normalizableBanner);
    expect(el(ACTION)?.textContent).toBe(COPY.normalizableAction);

    stubs.doc.fire(ACTION, "click", {});
    await flush();
    await flush();
    await flush();

    expect(requestBodies("/api/doc/doc.html/normalize")).toEqual([{}]);
    // 重进 managed：info 再取一次，主题/正文/model 这批依赖这时才出现。
    expect(stubs.fetched.filter((url) => url.endsWith("/info"))).toHaveLength(2);
    expect(stubs.fetched).toContain("/api/doc/doc.html/model");
    expect(stubs.fetched).toContain("/api/doc/doc.html/outline");
    expect(stubs.fetched).toContain("/api/theme");
    expect(stubs.fetched).toContain("/s/doc.html");
    expect(el(FRAME)?.attrs.get("hidden")).toBe("");
  });

  it("should keep the shell and show the error when normalize is refused", async () => {
    install("doc.html", "http://x/", (url) =>
      url.endsWith("/normalize")
        ? jsonOf({ revision: "r2" }) // 缺 cls：形状不符
        : url.endsWith("/info")
          ? jsonOf(normalizableInfo)
          : happy(url),
    );
    installForeignDom();
    await load();

    stubs.doc.fire(ACTION, "click", {});
    await flush();

    expect(el(ERROR)?.textContent).toBe("/api/doc/doc.html/normalize → 响应形状不符");
    expect(el(FRAME)?.attrs.has("hidden")).toBe(false);
  });
});

describe("main · 外来主题（POST /api/style）", () => {
  const SELECT = `${ROOT} #hr-theme-select`;

  it("should POST /api/style through the real deps wiring and reload the iframe", async () => {
    install("doc.html", "http://x/", (url) =>
      url === "/api/style" ? jsonOf({ changed: true, revision: "r2" }) : foreignDoc()(url),
    );
    installForeignDom();
    await load();

    // 主题清单来自 /api/theme 桩（atelier-editorial 为默认）：选项与选中态要画出来。
    const select = el(SELECT);
    expect(select?.attrs.get("value")).toBe("atelier-editorial");

    stubs.doc.fire(SELECT, "change", { value: "manuscript" });
    await flush();

    expect(requestBodies("/api/style")).toEqual([{ docId: "doc.html", visualId: "manuscript" }]);
    expect(el(FRAME)?.attrs.get("src")).toBe("/s/doc.html?r=n1");
  });

  it("should roll the select back when the style write is rejected", async () => {
    install("doc.html", "http://x/", (url) =>
      url === "/api/style" ? jsonOf({ bogus: true }) : foreignDoc()(url),
    );
    installForeignDom();
    await load();

    stubs.doc.fire(SELECT, "change", { value: "manuscript" });
    await flush();

    expect(el(SELECT)?.attrs.get("value")).toBe("atelier-editorial");
    expect(el(ERROR)?.textContent).toBe("/api/style → 响应形状不符");
    expect(el(FRAME)?.attrs.get("src")).toBe("/s/doc.html");
  });
});

describe("main · info 形状守卫", () => {
  it("should reject info payloads without a known cls", async () => {
    const { isDocInfo } = await import("../src/main.ts");

    expect(isDocInfo({ revision: "r1", cls: "managed" })).toBe(true);
    expect(isDocInfo({ revision: "r1", cls: "normalizable" })).toBe(true);
    expect(isDocInfo({ revision: "r1", cls: "foreign" })).toBe(true);
    expect(isDocInfo({ revision: "r1", cls: "bogus" })).toBe(false);
    expect(isDocInfo({ cls: "managed" })).toBe(false);
    expect(isDocInfo(null)).toBe(false);
  });

  it("should validate the nested permissions view field by field", async () => {
    const { isDocInfo } = await import("../src/main.ts");

    const base = { revision: "r1", cls: "foreign", trust: "off", scripts: true };
    const perms = {
      scripts: true,
      network: false,
      scriptsSource: "doc",
      networkSource: "global",
      modes: { scripts: "allow", network: "per-doc" },
    };
    expect(isDocInfo({ ...base, permissions: perms })).toBe(true);
    for (const bad of [
      { ...perms, scriptsSource: "bogus" },
      { ...perms, networkSource: "bogus" },
      { ...perms, scriptsSource: 1 },
      { ...perms, modes: { scripts: "always", network: "per-doc" } },
      { ...perms, modes: "per-doc" },
      { ...perms, scripts: "yes" },
    ]) {
      expect(isDocInfo({ ...base, permissions: bad }), JSON.stringify(bad)).toBe(false);
    }
  });
});
