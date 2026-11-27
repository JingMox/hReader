// Document templates: the new-doc select, the settings section, the
// save-as-template modal and the bridge URLs each submits. The Rust side is
// stubbed by calling `window.__hrTemplateResult` directly.
import { describe, expect, it, vi } from "vitest";
import type { HTMLInputElement, HTMLSelectElement } from "happy-dom";

import { createSandbox, mustGet } from "./harness.ts";
import type { Sandbox } from "./harness.ts";

const TEMPLATES = [
  {
    id: "blank-html",
    name: "Blank HTML",
    description: "",
    format: "single",
    tags: [],
    source: "builtin",
  },
  {
    id: "weekly-report",
    name: "周报",
    description: "d",
    format: "single",
    tags: ["work"],
    source: "user",
  },
  {
    id: "ws-note",
    name: "工作区笔记",
    description: "",
    format: "single",
    tags: [],
    source: "workspace",
  },
];

function pushList(s: Sandbox, ok = true): void {
  const push = s.window.__hrTemplateResult;
  if (!push) throw new Error("__hrTemplateResult 未注册");
  push(
    ok
      ? { ok: true, templates: TEMPLATES, diagnostics: [] }
      : { ok: false, message: "spawn failed" },
  );
}

function tplSelect(s: Sandbox): HTMLSelectElement {
  return mustGet(s.document, "#hrd-new-template") as HTMLSelectElement;
}

function optionValues(sel: HTMLSelectElement): string[] {
  return [...sel.options].map((o) => o.value);
}

describe("new-doc modal · template select", () => {
  it("requests the list on open and renders options from the pushed payload", () => {
    const s = createSandbox();
    s.hrd.openNewDocModal();
    // The modal asks Rust for a fresh list via the token-gated bridge.
    expect(s.window.location.href).toBe("http://hr-desktop.local/template-list?t=test-token");

    pushList(s);
    expect(optionValues(tplSelect(s))).toEqual(["", "blank-html", "weekly-report", "ws-note"]);
    const labels = [...tplSelect(s).options].map((o) => o.textContent);
    expect(labels[1]).toBe("Blank HTML（builtin）");
    expect(labels[2]).toBe("周报（user）");
    s.dispose();
  });

  it("preselects the default template from ctx", () => {
    const s = createSandbox({ ctx: { defaultTemplate: "weekly-report" } });
    s.hrd.openNewDocModal();
    pushList(s);
    expect(tplSelect(s).value).toBe("weekly-report");
    s.dispose();
  });

  it("ignores a default that is not in the list", () => {
    const s = createSandbox({ ctx: { defaultTemplate: "ghost" } });
    s.hrd.openNewDocModal();
    pushList(s);
    expect(tplSelect(s).value).toBe("");
    s.dispose();
  });

  it("falls back to blank-only plus an inline hint when listing fails", () => {
    const s = createSandbox();
    s.hrd.openNewDocModal();
    pushList(s, false);
    expect(optionValues(tplSelect(s))).toEqual([""]);
    expect(mustGet(s.document, "#hrd-new-template-hint").textContent).toContain("模板列表加载失败");
    s.dispose();
  });

  it("blank selection keeps the exact pre-template /new bridge URL", () => {
    const s = createSandbox();
    s.hrd.openNewDocModal();
    pushList(s);
    (mustGet(s.document, "#hrd-new-title") as HTMLInputElement).value = "My Doc";
    (mustGet(s.document, "#hrd-new-name") as HTMLInputElement).value = "my doc.html";
    tplSelect(s).value = "";
    mustGet(s.document, "#hrd-new-ok").dispatchEvent(
      new s.window.MouseEvent("click", { bubbles: true }),
    );
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/new?title=My%20Doc&file=my%20doc.html&t=test-token",
    );
    s.dispose();
  });

  it("template selection appends &template=<id> to /new", () => {
    const s = createSandbox();
    s.hrd.openNewDocModal();
    pushList(s);
    tplSelect(s).value = "weekly-report";
    mustGet(s.document, "#hrd-new-ok").dispatchEvent(
      new s.window.MouseEvent("click", { bubbles: true }),
    );
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/new?title=%E6%9C%AA%E5%91%BD%E5%90%8D%E6%96%87%E6%A1%A3&file=&template=weekly-report&t=test-token",
    );
    s.dispose();
  });
});

describe("settings modal · document templates section", () => {
  function openSettingsWithList(s: Sandbox): void {
    s.hrd.openSettingsModal();
    pushList(s);
  }

  it("renders every listed template with id, name and source", () => {
    const s = createSandbox();
    openSettingsWithList(s);
    const box = mustGet(s.document, "#hrd-tpl-section");
    expect(box.textContent).toContain("周报");
    expect(box.textContent).toContain("weekly-report · user");
    expect(box.textContent).toContain("blank-html");
    expect(box.textContent).toContain("ws-note · workspace");
    s.dispose();
  });

  it("shows diagnostics rows when the CLI reports broken templates", () => {
    const s = createSandbox();
    s.hrd.openSettingsModal();
    s.window.__hrTemplateResult?.({
      ok: true,
      templates: [],
      diagnostics: [{ id: "broken", source: "user", message: "template.json 不是 JSON" }],
    });
    const box = mustGet(s.document, "#hrd-tpl-section");
    expect(box.textContent).toContain("broken");
    expect(box.textContent).toContain("template.json 不是 JSON");
    s.dispose();
  });

  it("open-dir buttons dispatch the right scope", () => {
    const s = createSandbox();
    openSettingsWithList(s);
    mustGet(s.document, "#hrd-set-tpl-open-user").dispatchEvent(
      new s.window.MouseEvent("click", { bubbles: true }),
    );
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/template-open-dir?scope=user&t=test-token",
    );
    mustGet(s.document, "#hrd-set-tpl-open-ws").dispatchEvent(
      new s.window.MouseEvent("click", { bubbles: true }),
    );
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/template-open-dir?scope=workspace&t=test-token",
    );
    s.dispose();
  });

  it("hides delete for builtin and shows it for user/workspace sources", () => {
    const s = createSandbox();
    openSettingsWithList(s);
    const deletes = [...s.document.querySelectorAll("[data-tpl-delete]")].map((el) =>
      el.getAttribute("data-tpl-delete"),
    );
    expect(deletes).toEqual(["weekly-report", "ws-note"]);
    const defaults = [...s.document.querySelectorAll("[data-tpl-default]")].map((el) =>
      el.getAttribute("data-tpl-default"),
    );
    // builtin rows still offer "设为默认" — it is a preference, not a fs action.
    expect(defaults).toEqual(["blank-html", "weekly-report", "ws-note"]);
    s.dispose();
  });

  it("set-default and clear-default dispatch their bridge paths", () => {
    const s = createSandbox();
    openSettingsWithList(s);
    s.document
      .querySelector('[data-tpl-default="weekly-report"]')
      ?.dispatchEvent(new s.window.MouseEvent("click", { bubbles: true }));
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/template-set-default?id=weekly-report&t=test-token",
    );

    // Rust answers via __hrDefaultTemplate; the row re-renders as 清除默认.
    s.window.__hrDefaultTemplate?.("weekly-report");
    s.document
      .querySelector("[data-tpl-clear]")
      ?.dispatchEvent(new s.window.MouseEvent("click", { bubbles: true }));
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/template-clear-default?t=test-token",
    );
    expect(s.hrd.state.ctx.defaultTemplate).toBe("weekly-report");
    s.dispose();
  });

  it("delete asks for confirmation before dispatching /template-delete", () => {
    const s = createSandbox();
    const navs: string[] = [];
    const orig = s.hrd.bridgeNavigate;
    s.hrd.bridgeNavigate = (path: string) => {
      navs.push(path);
      orig(path);
    };
    openSettingsWithList(s);
    navs.length = 0;
    s.document
      .querySelector('[data-tpl-delete="weekly-report"]')
      ?.dispatchEvent(new s.window.MouseEvent("click", { bubbles: true }));
    // Confirmation modal replaced the settings modal — nothing dispatched yet.
    expect(navs).toEqual([]);
    mustGet(s.document, "#hrd-tpldel-ok").dispatchEvent(
      new s.window.MouseEvent("click", { bubbles: true }),
    );
    // Delete is dispatched, then the reopened settings modal refreshes the list.
    expect(navs).toEqual(["/template-delete?id=weekly-report", "/template-list"]);
    s.dispose();
  });
});

describe("save-as-template modal", () => {
  it("refuses to open without a document and toasts", () => {
    const s = createSandbox({ ctx: { docId: "" } });
    s.hrd.showToast = vi.fn();
    s.hrd.openSaveAsTemplateModal();
    expect(s.document.querySelector("#hrd-tpl-id")).toBeNull();
    expect(s.hrd.showToast).toHaveBeenCalled();
    s.dispose();
  });

  it("rejects an invalid id before any bridge call", () => {
    const s = createSandbox({ ctx: { docId: "doc.html" } });
    s.hrd.showToast = vi.fn();
    s.hrd.openSaveAsTemplateModal();
    const before = s.window.location.href;
    for (const bad of ["Bad Id", "..", "a/b", "-lead", "a?x"]) {
      (mustGet(s.document, "#hrd-tpl-id") as HTMLInputElement).value = bad;
      mustGet(s.document, "#hrd-tpl-ok").dispatchEvent(
        new s.window.MouseEvent("click", { bubbles: true }),
      );
    }
    expect(s.window.location.href).toBe(before);
    expect(s.hrd.showToast).toHaveBeenCalled();
    s.dispose();
  });

  it("submits doc, id, name, desc and global as a query", () => {
    const s = createSandbox({
      ctx: { docId: "notes/a.html" },
      url: "http://127.0.0.1:8123/?doc=notes%2Fa.html",
    });
    s.hrd.openSaveAsTemplateModal();
    (mustGet(s.document, "#hrd-tpl-id") as HTMLInputElement).value = "weekly-report";
    (mustGet(s.document, "#hrd-tpl-name") as HTMLInputElement).value = "周 报";
    (mustGet(s.document, "#hrd-tpl-desc") as HTMLInputElement).value = '有"引号"';
    (mustGet(s.document, "#hrd-tpl-global") as HTMLInputElement).checked = true;
    mustGet(s.document, "#hrd-tpl-ok").dispatchEvent(
      new s.window.MouseEvent("click", { bubbles: true }),
    );
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/template-save?doc=notes%2Fa.html&id=weekly-report&name=%E5%91%A8%20%E6%8A%A5&desc=%E6%9C%89%22%E5%BC%95%E5%8F%B7%22&global=1&t=test-token",
    );
    s.dispose();
  });
});
