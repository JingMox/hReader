// 这层管：桥令牌移出 init script 之后的回归——
// 页面 JS 现在靠 `__hrDesktopSync`（win.eval 只跑主 frame）拿 `ctx.bridgeToken`，
// 各原生动作的 `hr-desktop.local` 导航仍回带 `?t=<token>`；
// 外来 iframe 只拿到 init script 的空令牌上下文，也没有 sync 投递，永远伪造不出合法 `t=`。

import { describe, expect, it } from "vitest";

import { createSandbox } from "./harness";

describe("桥令牌投递 · init 空、sync 补", () => {
  it("init ctx 的 bridgeToken 为空：桥导航回带空 t=，壳会拒", () => {
    // init_script 注入的上下文恒为 ""（script.rs 已断言字节里没有令牌）：
    // WebView2 把它打进了外来 iframe，这一面必须保持空。
    const s = createSandbox({ ctx: { bridgeToken: "" } });
    s.hrd.bridgeNavigate("/drag");

    expect(s.window.location.href).toBe("http://hr-desktop.local/drag?t=");
    s.dispose();
  });

  it("__hrDesktopSync 把真令牌同步进 state 与 __HR_DESKTOP_CTX__", () => {
    const s = createSandbox({ ctx: { bridgeToken: "" } });
    s.window.__hrDesktopSync?.({ ...s.ctx, bridgeToken: "sync-tok-7" });

    expect(s.hrd.state.ctx.bridgeToken).toBe("sync-tok-7");
    expect(s.window.__HR_DESKTOP_CTX__?.bridgeToken).toBe("sync-tok-7");
    s.dispose();
  });
});

describe("桥令牌投递后 · 原生动作回带令牌", () => {
  const cases: readonly [string, string, string][] = [
    ["拖动窗口 /drag", "/drag", "http://hr-desktop.local/drag?t=sync-tok-7"],
    [
      "打开文件 /open?doc=",
      "/open?doc=a%20b.html",
      "http://hr-desktop.local/open?doc=a%20b.html&t=sync-tok-7",
    ],
    [
      "新建 /new",
      "/new?title=t&file=n.html",
      "http://hr-desktop.local/new?title=t&file=n.html&t=sync-tok-7",
    ],
    ["选择文件夹 /pick-folder", "/pick-folder", "http://hr-desktop.local/pick-folder?t=sync-tok-7"],
    ["打开文件 /pick-file", "/pick-file", "http://hr-desktop.local/pick-file?t=sync-tok-7"],
  ];

  for (const [label, path, url] of cases) {
    it(label, () => {
      const s = createSandbox({ ctx: { bridgeToken: "" } });
      s.window.__hrDesktopSync?.({ ...s.ctx, bridgeToken: "sync-tok-7" });

      s.hrd.bridgeNavigate(path);

      expect(s.window.location.href).toBe(url);
      s.dispose();
    });
  }

  it("Reveal 与 PDF/PNG/HTML 导出经 runExportAction 回带令牌", () => {
    const s = createSandbox({ ctx: { bridgeToken: "", docId: "d.html" } });
    s.window.__hrDesktopSync?.({ ...s.ctx, bridgeToken: "sync-tok-7" });

    s.hrd.runExportAction("reveal");
    expect(s.window.location.href).toBe("http://hr-desktop.local/reveal?doc=d.html&t=sync-tok-7");
    for (const kind of ["pdf", "png", "html"]) {
      s.hrd.runExportAction(kind);
      expect(s.window.location.href).toBe(
        `http://hr-desktop.local/export-${kind}?doc=d.html&t=sync-tok-7`,
      );
    }
    s.dispose();
  });
});

describe("外来 iframe 拿不到令牌", () => {
  it("iframe 是独立 realm：主 frame 的 ctx、__hrd、__hrDesktopSync 都够不着", () => {
    const s = createSandbox({ ctx: { bridgeToken: "sync-tok-7" } });
    const frame = s.document.createElement("iframe");
    s.document.body.append(frame);

    // 外来 iframe 里跑的是 init script（bridgeToken 恒空），win.eval 的 sync 只投主 frame：
    // 它既没有主 frame 的令牌，也没有投递令牌的入口。
    const inner = frame.contentWindow;
    if (inner !== null) {
      expect("__HR_DESKTOP_CTX__" in inner).toBe(false);
      expect("__hrd" in inner).toBe(false);
      expect("__hrDesktopSync" in inner).toBe(false);
    }
    s.dispose();
  });

  it("只拿到 init 上下文的页面（含 iframe）：sync 不到，令牌一直是空", () => {
    // 外来 iframe 的完整处境：init script 给了空令牌 + 全套模块，
    // 但 sync_payload_js 经 win.eval 只跑主 frame——令牌永远补不进来。
    const s = createSandbox({ ctx: { bridgeToken: "" } });

    expect(s.hrd.state.ctx.bridgeToken).toBe("");
    s.hrd.bridgeNavigate("/open?doc=x.html");
    expect(s.window.location.href).toBe("http://hr-desktop.local/open?doc=x.html&t=");
    s.dispose();
  });
});
