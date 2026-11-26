// 沉浸模式的壳层行为：唯一真相源是 #hr-root[data-hr-immersive]；壳把它镜像成
// body[data-hrd-immersive]（workbench.css 收掉 !important 定位的桌面装饰），
// 菜单动作与底栏按钮走同一个 app 出口，不允许第二条状态机。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createSandbox, mustGet } from "./harness.ts";
import type { Sandbox } from "./harness.ts";

const WORKBENCH_CSS = readFileSync(
  fileURLToPath(new URL("../webview/workbench.css", import.meta.url)),
  "utf8",
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function root(s: Sandbox) {
  return mustGet(s.document, "#hr-root");
}

describe("沉浸模式 · 镜像", () => {
  it("bootstrap 接线后翻转 data-hr-immersive 会同步 body[data-hrd-immersive]", async () => {
    const s = createSandbox();
    expect(s.document.body.hasAttribute("data-hrd-immersive")).toBe(false);

    root(s).setAttribute("data-hr-immersive", "");
    await flush();
    expect(s.document.body.hasAttribute("data-hrd-immersive")).toBe(true);

    root(s).removeAttribute("data-hr-immersive");
    await flush();
    expect(s.document.body.hasAttribute("data-hrd-immersive")).toBe(false);
    s.dispose();
  });

  it("wireImmersiveSync 幂等：重复调用不重复挂观察器", async () => {
    const s = createSandbox();
    s.hrd.wireImmersiveSync();
    s.hrd.wireImmersiveSync();
    root(s).setAttribute("data-hr-immersive", "");
    await flush();
    expect(s.document.body.hasAttribute("data-hrd-immersive")).toBe(true);
    s.dispose();
  });

  it("没有 #hr-root 的页面直接返回，不抛异常", () => {
    const s = createSandbox({ html: "<div>空壳页</div>", bootstrap: false });
    s.hrd.wireImmersiveSync();
    expect(s.document.body.hasAttribute("data-hrd-immersive")).toBe(false);
    s.dispose();
  });
});

describe("沉浸模式 · 出口", () => {
  it("toggleImmersive 点击 app 的底栏按钮（同一条 intent 链）", () => {
    const s = createSandbox();
    const btn = mustGet(s.document, "#hr-immersive-btn");
    let clicks = 0;
    btn.addEventListener("click", () => {
      clicks += 1;
      root(s).setAttribute("data-hr-immersive", "");
    });

    s.hrd.toggleImmersive();
    expect(clicks).toBe(1);
    s.dispose();
  });

  it("按钮缺席且未在沉浸态时给出可读提示而不是静默失败", () => {
    const s = createSandbox();
    mustGet(s.document, "#hr-immersive-btn").remove();
    const toast = vi.spyOn(s.hrd, "showToast");
    s.hrd.toggleImmersive();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]?.[1]).toBe(true);
    s.dispose();
  });

  it("原生菜单动作经 __hrMenuAction 汇聚到同一个出口", () => {
    const s = createSandbox();
    const spy = vi.spyOn(s.hrd, "toggleImmersive");
    s.window.__hrMenuAction?.("toggle-immersive");
    expect(spy).toHaveBeenCalledTimes(1);
    s.dispose();
  });
});

describe("沉浸模式 · CSS 闸门", () => {
  it("workbench.css 里有针对 body[data-hrd-immersive] 的隐藏规则", () => {
    for (const sel of [
      "body[data-hrd-immersive] #hr-statusbar",
      "body[data-hrd-immersive] #hr-library",
      "body[data-hrd-immersive] #hr-notes",
      "body[data-hrd-immersive] #hrd-overlay-title",
      "body[data-hrd-immersive] #hrd-block-gutter",
      "body[data-hrd-immersive] #hrd-sb-hotzone",
    ]) {
      expect(WORKBENCH_CSS, `缺隐藏规则 ${sel}`).toContain(sel);
    }
    // 底栏是 fixed+flex !important：光藏了不够，还得压掉它的定位才算真正消失。
    expect(WORKBENCH_CSS).toMatch(/body\[data-hrd-immersive\][^{]*\{[^}]*display: none !important/);
    // 三栏 grid 同样带 !important：两列必须塌成 0，只藏元素会留白条。
    expect(WORKBENCH_CSS).toContain("grid-template-columns: 0px minmax(0, 1fr) 0px !important");
  });
});
