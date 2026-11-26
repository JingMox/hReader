// 渲染层的注入安全与状态渲染：文件树/空状态/主题选项全部走 escapeHtmlText；
// docError 必须只挡当前文档，不得把攻击面带进 innerHTML。
import { describe, expect, it, vi } from "vitest";
import type { HTMLElement } from "happy-dom";

import { createSandbox, mustGet } from "./harness.ts";

describe("文件树渲染", () => {
  it("文件名里的 HTML 被转义，不变成真节点", () => {
    const s = createSandbox({
      ctx: {
        docId: "ok.html",
        files: ['<img src=x onerror="alert(1)">.html', "ok.html"],
      },
    });
    s.hrd.renderFilesPanel("");
    const panel = mustGet(s.document, "#hr-files-panel");
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.innerHTML).toContain("&lt;img src=x onerror=");
    s.dispose();
  });

  it("目录嵌套 + 展开记忆 + 过滤", () => {
    const s = createSandbox({
      ctx: {
        files: ["a/x.html", "a/deep/y.html", "b/z.html"],
        tree: [
          {
            name: "a",
            path: "a",
            kind: "dir",
            children: [
              { name: "x.html", path: "a/x.html", kind: "file" },
              {
                name: "deep",
                path: "a/deep",
                kind: "dir",
                children: [{ name: "y.html", path: "a/deep/y.html", kind: "file" }],
              },
            ],
          },
          {
            name: "b",
            path: "b",
            kind: "dir",
            children: [{ name: "z.html", path: "b/z.html", kind: "file" }],
          },
        ],
      },
    });
    s.hrd.renderFilesPanel("");
    const panel = mustGet(s.document, "#hr-files-panel");
    // 未展开时子目录内容折叠但仍渲染。
    expect(panel.querySelectorAll("[data-hrd-dir]").length).toBe(3);
    expect(panel.querySelectorAll("[data-hrd-file]").length).toBe(3);
    // 过滤命中文件名：无关目录整棵消失。
    s.hrd.renderFilesPanel("z.h");
    expect(panel.querySelectorAll("[data-hrd-file]").length).toBe(1);
    expect(panel.querySelector('[data-hrd-file="b/z.html"]')).not.toBeNull();
    s.dispose();
  });

  it("当前文档所在目录被自动展开并持久化", () => {
    const s = createSandbox({
      ctx: { docId: "a/deep/y.html", files: ["a/deep/y.html"] },
    });
    s.hrd.renderFilesPanel("");
    expect(s.hrd.state.expandedDirs.has("a")).toBe(true);
    expect(s.hrd.state.expandedDirs.has("a/deep")).toBe(true);
    const raw = s.window.localStorage.getItem("hrd_tree_open_/tmp/ws");
    expect(raw).toBeTruthy();
    expect(JSON.parse(String(raw))).toEqual(expect.arrayContaining(["a", "a/deep"]));
    s.dispose();
  });
});

describe("空状态与 docError", () => {
  it("docError 渲染错误标题与原因，且全部转义", () => {
    const s = createSandbox({
      ctx: {
        docId: "",
        docError: {
          docId: '<script>alert("x")</script>.html',
          message: "解析失败 <img src=x onerror=alert(2)>",
        },
      },
    });
    const docEl = mustGet(s.document, "#hr-doc");
    expect(docEl.querySelector("script")).toBeNull();
    expect(docEl.querySelector("img")).toBeNull();
    expect(docEl.innerHTML).toContain("这份文档打不开");
    expect(docEl.innerHTML).toContain("&lt;script&gt;alert(");
    s.dispose();
  });

  it("docError 有重试按钮：点击回发 /open?doc= 桥导航", () => {
    const s = createSandbox({
      ctx: {
        docId: "",
        bridgeToken: "tk",
        docError: { docId: "bad doc.html", message: "invalid_document" },
      },
    });
    const retry = mustGet(s.document, "#hrd-empty-retry") as HTMLElement;
    retry.click();
    expect(s.window.location.href).toBe("http://hr-desktop.local/open?doc=bad%20doc.html&t=tk");
    s.dispose();
  });

  it("无 docError 的空态不给重试按钮", () => {
    const s = createSandbox({ ctx: { docId: "" } });
    expect(s.document.querySelector("#hrd-empty-retry")).toBeNull();
    expect(s.document.querySelector("#hrd-empty-new")).not.toBeNull();
    s.dispose();
  });
});

describe("主题选项与解析", () => {
  it("buildUiThemeOptionsHtml 转义自定义主题名与 id", () => {
    const s = createSandbox({
      ctx: {
        customThemes: [
          {
            id: 'evil"><script>x</script>',
            name: '"><img src=x onerror=alert(1)>',
            base: "light",
            vars: {},
            css: "",
          },
        ],
      },
    });
    const html = s.hrd.buildUiThemeOptionsHtml();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    s.dispose();
  });

  it("prefs.uiTheme 指向不存在的主题时回落 light", () => {
    const s = createSandbox({
      beforeLoad: (win) => {
        win.localStorage.setItem("hr_desktop_prefs_v3", JSON.stringify({ uiTheme: "ghost" }));
      },
    });
    s.hrd.applyPrefs();
    expect(s.document.body.getAttribute("data-hrd-theme")).toBe("light");
    expect(s.hrd.state.prefs.uiTheme).toBe("light");
    s.dispose();
  });

  it("合法自定义主题应用 vars + css 到专属 style 元素", () => {
    const s = createSandbox({
      beforeLoad: (win) => {
        win.localStorage.setItem("hr_desktop_prefs_v3", JSON.stringify({ uiTheme: "nord" }));
      },
      ctx: {
        customThemes: [
          {
            id: "nord",
            name: "Nord",
            base: "dark",
            vars: { "--hr-accent": "#88c0d0" },
            css: ".x{color:red}",
          },
        ],
      },
    });
    s.hrd.applyPrefs();
    const styleEl = mustGet(s.document, "#hr-desktop-custom-theme");
    expect(styleEl.textContent).toContain("--hr-accent: #88c0d0;");
    expect(styleEl.textContent).toContain(".x{color:red}");
    expect(s.document.body.getAttribute("data-hrd-theme")).toBe("dark");
    s.dispose();
  });
});

describe("标题面包屑与导出分发", () => {
  it("updateDocBadge 转义 docId 里的 HTML", () => {
    const s = createSandbox({
      ctx: { docId: "a/<img src=x onerror=alert(1)>.html" },
    });
    s.hrd.updateDocBadge();
    const title = mustGet(s.document, "#hrd-overlay-title");
    expect(title.querySelector("img")).toBeNull();
    expect(title.innerHTML).toContain("&lt;img");
    s.dispose();
  });

  it("runExportAction：print 调 window.print，reveal/export 走桥导航", () => {
    const s = createSandbox({ ctx: { bridgeToken: "z", docId: "d.html" } });
    s.hrd.runExportAction("print");
    expect(s.print).toHaveBeenCalled();
    s.hrd.runExportAction("reveal");
    expect(s.window.location.href).toBe("http://hr-desktop.local/reveal?doc=d.html&t=z");
    s.hrd.runExportAction("pdf");
    expect(s.window.location.href).toBe("http://hr-desktop.local/export-pdf?doc=d.html&t=z");
    s.dispose();
  });

  it("空文档模式下 runExportAction 只放行 reveal", () => {
    const s = createSandbox({ ctx: { docId: "", bridgeToken: "z" } });
    s.hrd.showToast = vi.fn();
    s.hrd.runExportAction("pdf");
    expect(s.hrd.showToast).toHaveBeenCalledWith(
      "当前未打开文档，请先新建或打开一个 HTML 文件",
      true,
    );
    expect(s.window.location.hostname).not.toBe("hr-desktop.local");
    s.hrd.runExportAction("reveal");
    expect(s.window.location.href).toBe("http://hr-desktop.local/reveal?t=z");
    s.dispose();
  });
});
