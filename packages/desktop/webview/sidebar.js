// 侧边栏、标题栏拖拽区、批注抽屉与空工作区引导页。
const hrd = window.__hrd;

function openNotesDrawer(open) {
  hrd.state.notesOpen = Boolean(open);
  const root = document.getElementById("hr-root");
  if (root) root.classList.toggle("hrd-notes-open", hrd.state.notesOpen);
  const btn = document.getElementById("hrd-sb-notes");
  if (btn) btn.classList.toggle("active", hrd.state.notesOpen);
}

function toggleLeftSidebar(forceOpen) {
  const root = document.getElementById("hr-root");
  if (!root) return;
  const hide = forceOpen !== undefined ? !forceOpen : !root.classList.contains("hrd-hide-left");
  root.classList.toggle("hrd-hide-left", hide);
  const btn = document.getElementById("hrd-sb-left");
  if (btn) btn.classList.toggle("active", !hide);
}

function renderSidebarHeader() {
  const head = document.getElementById("hrd-side-head");
  if (!head) return;
  const { ICONS, escapeHtmlText } = hrd;
  const searchCls = hrd.state.searchOpen ? "active" : "";
  if (hrd.state.activeSidebarTab === "files") {
    head.innerHTML = `
      <button type="button" class="hrd-vault-btn" id="hrd-ws-pick" title="切换笔记库根目录 (${escapeHtmlText(hrd.state.ctx.workspace || "")})">
        ${ICONS.vault}
        <span class="hrd-vault-name">${escapeHtmlText(hrd.workspaceBaseName())}</span>
        <span style="font-size:10px;opacity:0.6;">▾</span>
      </button>
      <div class="hrd-side-actions">
        <button type="button" class="hrd-icon-btn" id="hrd-mode-toc" title="切换到大纲视图">${ICONS.toToc}</button>
        <button type="button" class="hrd-icon-btn ${searchCls}" id="hrd-toggle-search" title="搜索文件或标题 ( / )">${ICONS.search}</button>
      </div>
    `;
    return;
  }
  head.innerHTML = `
    <button type="button" class="hrd-icon-btn" id="hrd-mode-files" title="返回笔记库文件树">${ICONS.toFiles}</button>
    <span class="hrd-sb-heading">OUTLINE</span>
    <button type="button" class="hrd-icon-btn ${searchCls}" id="hrd-toggle-search" title="过滤大纲或文件 ( / )">${ICONS.search}</button>
  `;
}

function setSidebarMode(mode) {
  hrd.state.activeSidebarTab = mode === "toc" ? "toc" : "files";
  hrd.writeStorage(window.sessionStorage, "hrd_sidebar_tab", hrd.state.activeSidebarTab);
  renderSidebarHeader();
  const toc = document.getElementById("hr-toc");
  const filesPanel = document.getElementById("hr-files-panel");
  const search = document.getElementById("hr-search");
  if (toc) toc.classList.toggle("hidden", hrd.state.activeSidebarTab !== "toc");
  if (filesPanel) filesPanel.classList.toggle("active", hrd.state.activeSidebarTab === "files");
  if (hrd.state.activeSidebarTab === "files") hrd.renderFilesPanel(search ? search.value : "");
}

function toggleSearchBox(force) {
  const search = document.getElementById("hr-search");
  if (!search) return;
  hrd.state.searchOpen = force !== undefined ? Boolean(force) : !hrd.state.searchOpen;
  search.classList.toggle("open", hrd.state.searchOpen);
  const btn = document.getElementById("hrd-toggle-search");
  if (btn) btn.classList.toggle("active", hrd.state.searchOpen);
  if (hrd.state.searchOpen) {
    search.focus();
    search.select();
  } else {
    search.value = "";
    hrd.filterToc("");
    hrd.renderFilesPanel("");
  }
}

function wireDragSurface(el) {
  if (!el) return;
  el.setAttribute("data-tauri-drag-region", "deep");
  if (el.dataset.hrdDragWired) return;
  el.dataset.hrdDragWired = "1";
  el.addEventListener("mousedown", (e) => {
    if (window.__TAURI_INTERNALS__) return;
    if (e.button !== 0 || e.target.closest("button, input, select, a")) return;
    if (e.detail === 1 || e.detail === 2) {
      e.preventDefault();
      e.stopImmediatePropagation();
      hrd.bridgeNavigate(e.detail === 1 ? "/drag" : "/toggle-maximize");
    }
  });
}

function ensureFallbackDragStrip() {
  if (document.getElementById("hr-root") || !document.body) return;
  if (document.getElementById("hrd-fallback-drag")) return;
  const strip = document.createElement("div");
  strip.id = "hrd-fallback-drag";
  strip.style.cssText =
    "position:fixed;top:0;left:0;right:0;height:36px;z-index:9999;pointer-events:auto;";
  wireDragSurface(strip);
  document.body.prepend(strip);
}

function ensureOverlayTitlebar() {
  const canvas = document.getElementById("hr-canvas");
  if (!canvas || document.getElementById("hrd-overlay-title")) return;
  const bar = document.createElement("div");
  bar.id = "hrd-overlay-title";
  wireDragSurface(bar);
  canvas.prepend(bar);
}

function handleSidebarHeadClick(e) {
  if (e.target.closest("#hrd-ws-pick")) hrd.bridgeNavigate("/pick-folder");
  else if (e.target.closest("#hrd-mode-toc")) setSidebarMode("toc");
  else if (e.target.closest("#hrd-mode-files")) setSidebarMode("files");
  else if (e.target.closest("#hrd-toggle-search")) toggleSearchBox();
}

function handleFilesPanelClick(e, search) {
  if (e.target.closest("#hrd-vault-new-btn")) {
    hrd.openNewDocModal();
    return;
  }
  // 页面资源标记：展开/收起该页的资源列表，不影响"点击行打开文档"。
  const assetToggle = e.target.closest("[data-hrd-assets]");
  if (assetToggle) {
    const key = "assets:" + assetToggle.getAttribute("data-hrd-assets");
    if (hrd.state.expandedDirs.has(key)) hrd.state.expandedDirs.delete(key);
    else hrd.state.expandedDirs.add(key);
    hrd.saveExpandedDirs(hrd.state.expandedDirs);
    hrd.renderFilesPanel(search.value);
    return;
  }
  const dirBtn = e.target.closest("[data-hrd-dir]");
  if (dirBtn) {
    const dirPath = dirBtn.getAttribute("data-hrd-dir");
    if (!dirPath) return;
    if (hrd.state.expandedDirs.has(dirPath)) hrd.state.expandedDirs.delete(dirPath);
    else hrd.state.expandedDirs.add(dirPath);
    hrd.saveExpandedDirs(hrd.state.expandedDirs);
    hrd.renderFilesPanel(search.value);
    return;
  }
  // 资源文件（含"显示所有文件"下的非 HTML 文件）：不当文档打开，交给系统默认程序。
  const assetBtn = e.target.closest("[data-hrd-asset]");
  if (assetBtn) {
    const assetPath = assetBtn.getAttribute("data-hrd-asset");
    if (assetPath) hrd.bridgeNavigate("/open-asset?doc=" + encodeURIComponent(assetPath));
    return;
  }
  const item = e.target.closest("[data-hrd-file]");
  const file = item && item.getAttribute("data-hrd-file");
  if (file) {
    hrd.writeStorage(window.sessionStorage, "hrd_auto_outline", "1");
    hrd.writeStorage(window.sessionStorage, "hrd_sidebar_tab", "toc");
    hrd.bridgeNavigate("/open?doc=" + encodeURIComponent(file));
  }
}

function buildSidebarEnhancements() {
  const lib = document.getElementById("hr-library");
  const toc = document.getElementById("hr-toc");
  const search = document.getElementById("hr-search");
  if (!lib || !toc || !search || document.getElementById("hrd-side-head")) return;

  search.removeAttribute("disabled");
  search.placeholder = "过滤大纲或文件…";
  search.title = "输入关键词过滤大纲标题或文件树";

  const spacer = document.createElement("div");
  spacer.id = "hrd-traffic-spacer";
  spacer.className = "hrd-traffic-spacer";
  wireDragSurface(spacer);

  const head = document.createElement("div");
  head.id = "hrd-side-head";
  head.className = "hrd-side-head";
  wireDragSurface(head);

  lib.prepend(head);
  lib.prepend(spacer);

  const filesPanel = document.createElement("div");
  filesPanel.id = "hr-files-panel";
  lib.insertBefore(filesPanel, toc.nextSibling);

  head.addEventListener("click", handleSidebarHeadClick);
  filesPanel.addEventListener("click", (e) => handleFilesPanelClick(e, search));
  search.addEventListener("input", () => {
    hrd.filterToc(search.value);
    hrd.renderFilesPanel(search.value);
  });
  setSidebarMode(hrd.state.activeSidebarTab);
}

function buildNotesDrawerChrome() {
  const notes = document.getElementById("hr-notes");
  if (!notes || document.getElementById("hrd-notes-hdr")) return;
  const hdr = document.createElement("div");
  hdr.id = "hrd-notes-hdr";
  hdr.className = "hrd-notes-hdr";
  hdr.innerHTML = `
    <span>批注与历史 Diff</span>
    <button type="button" class="hrd-icon-btn" id="hrd-notes-close" title="收起批注栏 (⌘⇧R)">×</button>
  `;
  notes.prepend(hdr);
  hdr.querySelector("#hrd-notes-close").addEventListener("click", () => openNotesDrawer(false));
}

function emptyStateHtml() {
  const ws = hrd.escapeHtmlText(hrd.state.ctx.workspace || "未选择工作区");
  // docError 只挡这一份文档：标题说清是哪份、原因是什么，其余引导动作照常可用。
  const docError =
    hrd.state.ctx.docError && typeof hrd.state.ctx.docError === "object"
      ? hrd.state.ctx.docError
      : null;
  const title = docError
    ? `这份文档打不开：${hrd.escapeHtmlText(docError.docId || "")}`
    : "当前目录暂无 HTML 笔记";
  const sub = docError
    ? hrd.escapeHtmlText(docError.message || "未知错误")
    : "可以直接在当前工作区新建一篇排版文档，或者切换至包含 .html 文档的笔记库文件夹。";
  const retryBtn = docError
    ? '<button type="button" class="hrd-btn hrd-btn-primary" id="hrd-empty-retry">重试打开这份文档</button>'
    : "";
  return `
    <div class="hrd-empty-state">
      <div class="hrd-empty-mark" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="6" y="4" width="6.2" height="24" rx="1.6" fill="currentColor"/>
          <path d="M12.2 15.2C14.8 11.8 18.4 10.8 21.8 11.8C24.9 12.7 26.5 15.3 26.5 19.1V28H20.3V19.9C20.3 17.5 19.2 16.4 17.3 16.4C15.1 16.4 13.4 18 12.2 20.1V15.2Z" fill="currentColor"/>
        </svg>
      </div>
      <h1 class="hrd-empty-title">${title}</h1>
      <p class="hrd-empty-sub">${sub}</p>
      <div class="hrd-empty-path">${ws}</div>
      <div class="hrd-empty-actions">
        ${retryBtn}
        <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-empty-new">+ 新建文档</button>
        <button type="button" class="hrd-btn" id="hrd-empty-folder">选择笔记库文件夹…</button>
        <button type="button" class="hrd-btn" id="hrd-empty-file">打开 HTML 文件…</button>
      </div>
      <button type="button" class="hrd-empty-link" id="hrd-empty-welcome">生成欢迎指南文档 (welcome.html)</button>
    </div>
  `;
}

function resetEmptyStatusChrome() {
  const connEl = document.getElementById("hr-conn");
  if (connEl) connEl.textContent = "未打开文档";
  const wordsEl = document.getElementById("hrd-sb-words-txt");
  if (wordsEl) wordsEl.textContent = "0 字";
  const tocEl = document.getElementById("hr-toc");
  if (tocEl && !tocEl.children.length) {
    tocEl.innerHTML =
      '<li style="padding:10px 8px;font-size:12px;color:var(--hr-muted);">当前未打开文档</li>';
  }
}

function renderEmptyState() {
  if (!hrd.isEmptyMode()) return;
  const docEl = document.getElementById("hr-doc");
  if (!docEl) return;
  docEl.innerHTML = emptyStateHtml();
  const retryBtn = docEl.querySelector("#hrd-empty-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      const docError = hrd.state.ctx.docError;
      if (docError && docError.docId) {
        hrd.bridgeNavigate("/open?doc=" + encodeURIComponent(docError.docId));
      }
    });
  }
  docEl.querySelector("#hrd-empty-new").addEventListener("click", hrd.openNewDocModal);
  docEl
    .querySelector("#hrd-empty-folder")
    .addEventListener("click", () => hrd.bridgeNavigate("/pick-folder"));
  docEl
    .querySelector("#hrd-empty-file")
    .addEventListener("click", () => hrd.bridgeNavigate("/pick-file"));
  docEl
    .querySelector("#hrd-empty-welcome")
    .addEventListener("click", () => hrd.bridgeNavigate("/welcome"));
  resetEmptyStatusChrome();
}

function updateDocBadge() {
  const docId = hrd.currentDocId();
  document.title = docId ? docId + " — hReader" : hrd.workspaceBaseName() + " — hReader";
  const titleEl = document.getElementById("hrd-overlay-title");
  if (!titleEl) return;
  if (docId) {
    const parts = docId.split("/").filter(Boolean);
    const name = parts.pop() || docId;
    const prefix = parts.length ? parts.join(" / ") + " / " : "";
    const prefixHtml = prefix ? `<span>${hrd.escapeHtmlText(prefix)}</span>` : "";
    titleEl.innerHTML =
      prefixHtml + `<span class="hrd-crumb-name">${hrd.escapeHtmlText(name)}</span>`;
  } else {
    titleEl.innerHTML = `<span class="hrd-crumb-name">${hrd.escapeHtmlText(hrd.workspaceBaseName())}</span><span> · 空白页</span>`;
  }
}

Object.assign(hrd, {
  openNotesDrawer,
  toggleLeftSidebar,
  renderSidebarHeader,
  setSidebarMode,
  toggleSearchBox,
  ensureFallbackDragStrip,
  ensureOverlayTitlebar,
  buildSidebarEnhancements,
  buildNotesDrawerChrome,
  renderEmptyState,
  updateDocBadge,
});
