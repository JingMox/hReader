// 快捷键与原生菜单动作分发：钉死此前回归过的 ⌘⇧O/N/S/E/P 与全部菜单动作映射。
import { describe, expect, it, vi } from "vitest";
import type { HTMLSelectElement } from "happy-dom";

import { createSandbox, keydown, mustGet } from "./harness.ts";
import type { Sandbox } from "./harness.ts";

function make(): Sandbox {
  const s = createSandbox();
  // 菜单/快捷键只调 hrd.* 注册表：全部换成间谍，断言的是"哪个动作派发给谁"。
  for (const name of [
    "openFileSwitcherModal",
    "openNewDocModal",
    "openSaveAsTemplateModal",
    "openSettingsModal",
    "openHelpModal",
    "openBlockHtmlModal",
    "openComponentModal",
    "insertAfterBlock",
    "deleteBlock",
    "undoDocument",
    "toggleSourceMode",
    "toggleLeftSidebar",
    "runExportAction",
    "convertBlockTag",
    "persistStyle",
    "flushBlockSave",
    "showToast",
    "bridgeNavigate",
    "toggleImmersive",
  ]) {
    s.hrd[name] = vi.fn();
  }
  (s.hrd.flushBlockSave as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (s.hrd.persistStyle as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  return s;
}

function menuAction(s: Sandbox, action: string): void {
  const dispatch = s.window.__hrMenuAction;
  if (!dispatch) throw new Error("__hrMenuAction 未注册");
  dispatch(action);
}

describe("⌘⇧ 快捷键（此前回归过的五条）", () => {
  it("⌘⇧O 落到打开文件切换器（MOD_SHORTCUTS 先于 shift 分支解析）", () => {
    const s = make();
    keydown(s.window, { key: "O", metaKey: true, shiftKey: true });
    expect(s.hrd.openFileSwitcherModal).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("⌘⇧N 落到新建文档", () => {
    const s = make();
    keydown(s.window, { key: "N", metaKey: true, shiftKey: true });
    expect(s.hrd.openNewDocModal).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("⌘⇧S 走 save-doc：flushBlockSave 然后提示已保存", async () => {
    const s = make();
    keydown(s.window, { key: "S", metaKey: true, shiftKey: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(s.hrd.flushBlockSave).toHaveBeenCalledTimes(1);
    expect(s.hrd.showToast).toHaveBeenCalledWith("文档已保存");
    s.dispose();
  });

  it("⌘⇧E 落到块 HTML 编辑", () => {
    const s = make();
    keydown(s.window, { key: "E", metaKey: true, shiftKey: true });
    expect(s.hrd.openBlockHtmlModal).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("⌘⇧P 调系统打印", () => {
    const s = make();
    keydown(s.window, { key: "P", metaKey: true, shiftKey: true });
    expect(s.print).toHaveBeenCalledTimes(1);
    s.dispose();
  });
});

describe("普通 ⌘ 快捷键", () => {
  it("⌘O/⌘N/⌘S/⌘E/⌘P/⌘/ 各就各位", () => {
    const s = make();
    keydown(s.window, { key: "o", metaKey: true });
    expect(s.hrd.openFileSwitcherModal).toHaveBeenCalled();
    keydown(s.window, { key: "n", metaKey: true });
    expect(s.hrd.openNewDocModal).toHaveBeenCalled();
    keydown(s.window, { key: ",", metaKey: true });
    expect(s.hrd.openSettingsModal).toHaveBeenCalled();
    keydown(s.window, { key: "e", metaKey: true });
    expect(s.hrd.openBlockHtmlModal).toHaveBeenCalled();
    keydown(s.window, { key: "/", metaKey: true });
    expect(s.hrd.toggleSourceMode).toHaveBeenCalled();
    keydown(s.window, { key: "p", metaKey: true });
    expect(s.print).toHaveBeenCalled();
    s.dispose();
  });

  it("⌘⇧K/L/R/F 走 shift 专属表", () => {
    const s = make();
    keydown(s.window, { key: "k", metaKey: true, shiftKey: true });
    expect(s.hrd.openComponentModal).toHaveBeenCalled();
    keydown(s.window, { key: "l", metaKey: true, shiftKey: true });
    expect(s.hrd.toggleLeftSidebar).toHaveBeenCalled();
    keydown(s.window, { key: "r", metaKey: true, shiftKey: true });
    expect(s.hrd.state.notesOpen).toBe(true);
    keydown(s.window, { key: "f", metaKey: true, shiftKey: true });
    expect(s.hrd.state.prefs.focusMode).toBe(true);
    s.dispose();
  });

  it("⌘Z 撤销；⌘⇧Z 也是撤销（当前没有 redo 映射）", () => {
    const s = make();
    keydown(s.window, { key: "z", metaKey: true });
    keydown(s.window, { key: "Z", metaKey: true, shiftKey: true });
    expect(s.hrd.undoDocument).toHaveBeenCalledTimes(2);
    s.dispose();
  });

  it("可编辑焦点下 ⌘Z 不拦原生撤销；⌘⇧Z 仍走 undoDocument", () => {
    const s = make();
    const input = s.document.createElement("input");
    s.document.body.appendChild(input);
    input.focus();
    expect(s.document.activeElement).toBe(input);
    keydown(s.window, { key: "z", metaKey: true });
    expect(s.hrd.undoDocument).not.toHaveBeenCalled();
    keydown(s.window, { key: "z", metaKey: true, shiftKey: true });
    expect(s.hrd.undoDocument).toHaveBeenCalledTimes(1);
    s.dispose();
  });
});

describe("焦点与修饰键门控", () => {
  it("/ 在非编辑焦点下展开搜索，编辑焦点下不抢输入", () => {
    const s = make();
    s.hrd.toggleSearchBox = vi.fn();
    keydown(s.window, { key: "/" });
    expect(s.hrd.toggleLeftSidebar).toHaveBeenCalledWith(true);
    expect(s.hrd.toggleSearchBox).toHaveBeenCalledWith(true);

    const s2 = make();
    s2.hrd.toggleSearchBox = vi.fn();
    const input = s2.document.createElement("input");
    s2.document.body.appendChild(input);
    input.focus();
    keydown(s2.window, { key: "/" });
    expect(s2.hrd.toggleSearchBox).not.toHaveBeenCalled();
    s.dispose();
    s2.dispose();
  });

  it("可编辑焦点下 ⌘O 仍生效（mod 快捷键不受编辑焦点拦截）", () => {
    const s = make();
    const input = s.document.createElement("input");
    s.document.body.appendChild(input);
    input.focus();
    keydown(s.window, { key: "o", metaKey: true });
    expect(s.hrd.openFileSwitcherModal).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("无修饰键的普通按键不触发任何动作", () => {
    const s = make();
    keydown(s.window, { key: "o" });
    keydown(s.window, { key: "s" });
    expect(s.hrd.openFileSwitcherModal).not.toHaveBeenCalled();
    expect(s.hrd.flushBlockSave).not.toHaveBeenCalled();
    s.dispose();
  });
});

describe("原生菜单动作分发", () => {
  it("每个菜单 id 都派发给对应动作", () => {
    const s = make();
    const cases: [string, () => unknown][] = [
      ["open-file", () => s.hrd.openFileSwitcherModal],
      ["pick-file", () => s.hrd.bridgeNavigate],
      ["pick-folder", () => s.hrd.bridgeNavigate],
      ["new-file", () => s.hrd.openNewDocModal],
      ["save-as-template", () => s.hrd.openSaveAsTemplateModal],
      ["settings", () => s.hrd.openSettingsModal],
      ["help", () => s.hrd.openHelpModal],
      ["edit-block", () => s.hrd.openBlockHtmlModal],
      ["insert-para", () => s.hrd.insertAfterBlock],
      ["insert-comp", () => s.hrd.openComponentModal],
      ["delete-block", () => s.hrd.deleteBlock],
      ["undo", () => s.hrd.undoDocument],
      ["toggle-source", () => s.hrd.toggleSourceMode],
      ["export-pdf", () => s.hrd.runExportAction],
      ["export-png", () => s.hrd.runExportAction],
      ["export-html", () => s.hrd.runExportAction],
      ["print", () => s.hrd.runExportAction],
      ["reveal", () => s.hrd.runExportAction],
      ["toggle-immersive", () => s.hrd.toggleImmersive],
    ];
    for (const [id, spy] of cases) {
      menuAction(s, id);
      expect(spy(), `${id} 必须有接收者`).toHaveBeenCalled();
    }
    expect(s.hrd.bridgeNavigate).toHaveBeenCalledWith("/pick-file");
    expect(s.hrd.bridgeNavigate).toHaveBeenCalledWith("/pick-folder");
    expect(s.hrd.runExportAction).toHaveBeenCalledWith("pdf");
    expect(s.hrd.runExportAction).toHaveBeenCalledWith("reveal");
    s.dispose();
  });

  it("tag:/comp:/theme:/ui: 前缀动作", () => {
    const s = make();
    menuAction(s, "tag:h2");
    expect(s.hrd.convertBlockTag).toHaveBeenCalledWith(expect.anything(), "h2");

    menuAction(s, "comp:kpi-bento");
    expect(s.hrd.insertAfterBlock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("kpi-bento"),
      expect.anything(),
      false,
    );

    // hr-theme-select 存在时 theme: 走 select.value + change 事件，
    // change 监听器再转发给 persistStyle——整条链必须走通。
    const sel = mustGet(s.document, "#hr-theme-select") as HTMLSelectElement;
    const opt = s.document.createElement("option");
    opt.value = "paper";
    sel.appendChild(opt);
    menuAction(s, "theme:paper");
    expect(sel.value).toBe("paper");
    expect(s.hrd.persistStyle).toHaveBeenCalledWith("paper");

    menuAction(s, "ui:dark");
    expect(s.hrd.state.prefs.uiTheme).toBe("dark");
    s.dispose();
  });

  it("未知动作与 comp: 不存在的 id 都是 no-op", () => {
    const s = make();
    menuAction(s, "nonexistent");
    menuAction(s, "comp:not-a-real-component");
    expect(s.hrd.insertAfterBlock).not.toHaveBeenCalled();
    s.dispose();
  });

  it("toggle-left/toggle-right/toggle-focus 走状态开关", () => {
    const s = make();
    menuAction(s, "toggle-left");
    expect(s.hrd.toggleLeftSidebar).toHaveBeenCalled();
    menuAction(s, "toggle-right");
    expect(s.hrd.state.notesOpen).toBe(true);
    menuAction(s, "toggle-focus");
    expect(s.hrd.state.prefs.focusMode).toBe(true);
    s.dispose();
  });
});
