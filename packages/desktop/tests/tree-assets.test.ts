// 文件树"页面资源折叠"：资产标记展开/持久化、资源行走 /open-asset 系统打开、
// page-folder 条目以 <title> 为显示名、"显示所有文件"开关还原原始目录结构。
import { describe, expect, it } from "vitest";
import type { HTMLElement, HTMLInputElement } from "happy-dom";

import { createSandbox, keydown, mustGet } from "./harness.ts";
import type { Sandbox, TreeNode } from "./harness.ts";

const PAGE_TREE: TreeNode[] = [
  {
    name: "note.html",
    path: "note.html",
    kind: "file",
    assets: [
      {
        name: "note_files",
        path: "note_files",
        kind: "dir",
        children: [
          { name: "style.css", path: "note_files/style.css", kind: "file", hidden: true },
          { name: "logo.png", path: "note_files/logo.png", kind: "file", hidden: true },
        ],
      },
      { name: "clip.mp4", path: "clip.mp4", kind: "file", hidden: true },
    ],
  },
  { name: "plain.html", path: "plain.html", kind: "file" },
];

const FOLDER_TREE: TreeNode[] = [
  {
    name: "site",
    path: "site",
    kind: "page-folder",
    title: "My Page & More",
    entry: "site/index.html",
    children: [{ name: "index.html", path: "site/index.html", kind: "file" }],
    assets: [
      {
        name: "assets",
        path: "site/assets",
        kind: "dir",
        children: [{ name: "a.css", path: "site/assets/a.css", kind: "file", hidden: true }],
      },
      { name: "pic.png", path: "site/pic.png", kind: "file", hidden: true },
    ],
  },
];

function makePageSandbox(): Sandbox {
  return createSandbox({
    ctx: { docId: "note.html", files: ["note.html", "plain.html"], tree: PAGE_TREE },
  });
}

function panel(s: Sandbox) {
  return mustGet(s.document, "#hr-files-panel");
}

describe("asset folding marker", () => {
  it("should render an assets toggle only on pages that carry assets", () => {
    const s = makePageSandbox();
    s.hrd.renderFilesPanel("");
    const p = panel(s);
    expect(p.querySelectorAll("[data-hrd-assets]").length).toBe(1);
    expect(p.querySelector('[data-hrd-assets="note.html"]')).not.toBeNull();
    // A page without assets stays a plain file row.
    expect(p.querySelector('[data-hrd-assets="plain.html"]')).toBeNull();
    // Asset rows are rendered inside a collapsed container by default.
    expect(p.querySelectorAll("[data-hrd-asset]").length).toBe(3);
    expect(p.querySelectorAll(".hrd-tree-children.collapsed").length).toBe(2);
    s.dispose();
  });

  it("should expand and persist the asset list when the marker is clicked", () => {
    const s = makePageSandbox();
    s.hrd.renderFilesPanel("");
    const toggle = mustGet(s.document, '[data-hrd-assets="note.html"]') as HTMLElement;
    toggle.click();
    expect(s.hrd.state.expandedDirs.has("assets:note.html")).toBe(true);
    const raw = s.window.localStorage.getItem("hrd_tree_open_/tmp/ws");
    expect(JSON.parse(String(raw))).toContain("assets:note.html");
    // The asset container opens; the nested dir inside stays collapsed.
    expect(panel(s).querySelectorAll(".hrd-tree-children.collapsed").length).toBe(1);
    // Collapse again.
    (mustGet(s.document, '[data-hrd-assets="note.html"]') as HTMLElement).click();
    expect(s.hrd.state.expandedDirs.has("assets:note.html")).toBe(false);
    expect(panel(s).querySelectorAll(".hrd-tree-children.collapsed").length).toBe(2);
    s.dispose();
  });

  it("should open an asset row with the system app, never inside the reader", () => {
    const s = makePageSandbox();
    s.hrd.renderFilesPanel("");
    const row = mustGet(s.document, '[data-hrd-asset="note_files/style.css"]') as HTMLElement;
    row.click();
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/open-asset?doc=note_files%2Fstyle.css&t=test-token",
    );
    s.dispose();
  });

  it("should escape HTML inside asset names and the assets badge", () => {
    const s = createSandbox({
      ctx: {
        files: ["a.html"],
        tree: [
          {
            name: "a.html",
            path: "a.html",
            kind: "file",
            assets: [
              {
                name: "x<img src=i onerror=alert(1)>.png",
                path: "a_files/x.png",
                kind: "file",
                hidden: true,
              },
            ],
          },
        ],
      },
    });
    s.hrd.renderFilesPanel("");
    const p = panel(s);
    expect(p.querySelector("img")).toBeNull();
    expect(p.innerHTML).toContain("&lt;img src=i");
    s.dispose();
  });

  it("should keep a page visible when the filter only matches an asset", () => {
    const s = makePageSandbox();
    s.hrd.renderFilesPanel("style");
    const p = panel(s);
    expect(p.querySelector('[data-hrd-file="note.html"]')).not.toBeNull();
    expect(p.querySelector('[data-hrd-asset="note_files/style.css"]')).not.toBeNull();
    expect(p.querySelector('[data-hrd-file="plain.html"]')).toBeNull();
    s.dispose();
  });
});

describe("page-folder entries", () => {
  it("should show the html title and open the entry document on click", () => {
    const s = createSandbox({
      ctx: { docId: "site/index.html", files: ["site/index.html"], tree: FOLDER_TREE },
    });
    s.hrd.renderFilesPanel("");
    const p = panel(s);
    // One row for the whole directory; the label is the page title.
    const row = mustGet(s.document, '[data-hrd-file="site/index.html"]');
    expect(row.querySelector(".hrd-tree-label")?.textContent).toBe("My Page & More");
    expect(row.getAttribute("title")).toBe("site");
    // It is still a document row, not a directory row.
    expect(p.querySelector('[data-hrd-dir="site"]')).toBeNull();
    // Resources fold behind the same marker.
    expect(p.querySelector('[data-hrd-assets="site"]')).not.toBeNull();
    (row as HTMLElement).click();
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/open?doc=site%2Findex.html&t=test-token",
    );
    s.dispose();
  });

  it("should fall back to the directory name when the page has no title", () => {
    const s = createSandbox({
      ctx: {
        files: ["bare/index.html"],
        tree: [
          {
            name: "bare",
            path: "bare",
            kind: "page-folder",
            entry: "bare/index.html",
            children: [{ name: "index.html", path: "bare/index.html", kind: "file" }],
          },
        ],
      },
    });
    s.hrd.renderFilesPanel("");
    const row = mustGet(s.document, '[data-hrd-file="bare/index.html"]');
    expect(row.querySelector(".hrd-tree-label")?.textContent).toBe("bare");
    s.dispose();
  });

  it("should escape the page title in the row label", () => {
    const s = createSandbox({
      ctx: {
        files: ["evil/index.html"],
        tree: [
          {
            name: "evil",
            path: "evil",
            kind: "page-folder",
            title: "<img src=x onerror=alert(1)>",
            entry: "evil/index.html",
            children: [{ name: "index.html", path: "evil/index.html", kind: "file" }],
          },
        ],
      },
    });
    s.hrd.renderFilesPanel("");
    const p = panel(s);
    expect(p.querySelector("img")).toBeNull();
    expect(p.innerHTML).toContain("&lt;img src=x onerror=");
    s.dispose();
  });
});

describe("show-all-files preference", () => {
  it("should unfold the raw directory structure when the pref is on", () => {
    const s = createSandbox({
      ctx: { docId: "site/index.html", files: ["site/index.html"], tree: FOLDER_TREE },
    });
    s.hrd.savePrefs({ ...s.hrd.state.prefs, showAllFiles: true });
    s.hrd.renderFilesPanel("");
    const p = panel(s);
    // The page-folder is a real directory again.
    const dir = mustGet(s.document, '[data-hrd-dir="site"]');
    expect(dir.querySelector(".hrd-tree-label")?.textContent).toBe("site");
    // index.html is a normal document row inside it.
    expect(p.querySelector('[data-hrd-file="site/index.html"]')).not.toBeNull();
    // Non-HTML siblings appear as asset rows, including the nested dir.
    expect(p.querySelector('[data-hrd-asset="site/pic.png"]')).not.toBeNull();
    expect(p.querySelector('[data-hrd-dir="site/assets"]')).not.toBeNull();
    // The footer counts the extra files.
    const foot = mustGet(s.document, ".hrd-vault-foot");
    expect(foot.textContent).toContain("个其他文件");
    s.dispose();
  });

  it("should spread a page's assets as siblings and route non-HTML clicks to the system app", () => {
    const s = makePageSandbox();
    s.hrd.savePrefs({ ...s.hrd.state.prefs, showAllFiles: true });
    s.hrd.renderFilesPanel("");
    const p = panel(s);
    // Assets sit next to their page in raw filesystem order.
    expect(p.querySelector('[data-hrd-dir="note_files"]')).not.toBeNull();
    const row = mustGet(s.document, '[data-hrd-asset="clip.mp4"]') as HTMLElement;
    row.click();
    expect(s.window.location.href).toBe(
      "http://hr-desktop.local/open-asset?doc=clip.mp4&t=test-token",
    );
    s.dispose();
  });

  it("should return to the folded view when the pref goes back off", () => {
    const s = makePageSandbox();
    s.hrd.savePrefs({ ...s.hrd.state.prefs, showAllFiles: true });
    s.hrd.renderFilesPanel("");
    // Unfolded: no fold markers at all, note_files is a top-level directory.
    expect(panel(s).querySelector("[data-hrd-assets]")).toBeNull();
    expect(panel(s).querySelector('[data-hrd-dir="note_files"]')).not.toBeNull();
    s.hrd.savePrefs({ ...s.hrd.state.prefs, showAllFiles: false });
    s.hrd.renderFilesPanel("");
    const p = panel(s);
    // Folded again: the marker is back and note_files only exists inside the
    // collapsed asset listing, not as a top-level directory.
    expect(p.querySelector('[data-hrd-assets="note.html"]')).not.toBeNull();
    expect(p.querySelectorAll(".hrd-tree-scroll > .hrd-tree-group > [data-hrd-dir]").length).toBe(
      0,
    );
    s.dispose();
  });

  it("should apply the toggle through the real settings modal", async () => {
    const s = makePageSandbox();
    s.hrd.renderFilesPanel("");
    s.hrd.openSettingsModal();
    const box = mustGet(s.document, "#hrd-set-showall") as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.checked = true;
    (mustGet(s.document, "#hrd-set-done") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.hrd.state.prefs.showAllFiles).toBe(true);
    const raw = s.window.localStorage.getItem("hr_desktop_prefs_v3");
    expect(JSON.parse(String(raw))).toMatchObject({ showAllFiles: true });
    // The panel re-rendered immediately with the raw structure.
    expect(panel(s).querySelector('[data-hrd-dir="note_files"]')).not.toBeNull();
    s.dispose();
  });
});

describe("keyboard and search regression", () => {
  it("should still open the search box on / with the folded tree rendered", () => {
    const s = makePageSandbox();
    s.hrd.renderFilesPanel("");
    keydown(s.window, { key: "/" });
    expect(s.hrd.state.searchOpen).toBe(true);
    const search = mustGet(s.document, "#hr-search");
    expect(search.classList.contains("open")).toBe(true);
    s.dispose();
  });

  it("should still toggle real directories and the expanded-dirs keys do not collide", () => {
    const s = makePageSandbox();
    s.hrd.renderFilesPanel("");
    // Asset state uses an "assets:" prefix; a directory named like it cannot
    // collide because real dir paths never start with that prefix.
    const toggle = mustGet(s.document, '[data-hrd-assets="note.html"]') as HTMLElement;
    toggle.click();
    const dirToggle = mustGet(s.document, '[data-hrd-dir="note_files"]') as HTMLElement;
    dirToggle.click();
    expect(s.hrd.state.expandedDirs.has("assets:note.html")).toBe(true);
    expect(s.hrd.state.expandedDirs.has("note_files")).toBe(true);
    s.dispose();
  });
});
