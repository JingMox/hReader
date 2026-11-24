// 工作台启动装配、文档交互事件、跨源鉴权恢复与上下文同步。
const hrd = window.__hrd;

function checkUnauthorizedRecovery() {
  const host = window.location.hostname;
  if (host !== "127.0.0.1" && host !== "localhost") return false;
  if (document.getElementById("hr-root")) return false;
  const text = (document.body && document.body.textContent) || "";
  if (!text.includes("访问凭据")) return false;
  const key = "hrd_reauth_tries_" + String(window.location.port || "0");
  const tries = Number(hrd.readStorage(window.sessionStorage, key) || "0");
  if (tries >= 3) return false;
  hrd.writeStorage(window.sessionStorage, key, String(tries + 1));
  hrd.bridgeNavigate("/reauth");
  return true;
}

function handleDocInput(e) {
  const target = hrd.closestTopBlock(e.target);
  if (!target || !hrd.isSimpleEditableBlock(target)) return;
  hrd.state.activeEditId = target.getAttribute("data-hr-id");
  if (hrd.tryMarkdownPrefix(target)) return;
  hrd.state.editDirty = true;
  hrd.setSaveState("未保存");
  if (hrd.state.saveTimer) clearTimeout(hrd.state.saveTimer);
  hrd.state.saveTimer = setTimeout(() => {
    if (document.contains(target)) hrd.flushBlockSave(target);
  }, 650);
}

async function handleBackspaceOnBlock(e, target) {
  const clean = (target.textContent || "").replace(/\u00a0/g, "").trim();
  if (clean === "" && hrd.contentBlocks().length > 1) {
    e.preventDefault();
    await hrd.deleteBlock(target);
  }
}

async function handleDocKeydown(e) {
  const target = hrd.closestTopBlock(e.target);
  if (!target || !hrd.isSimpleEditableBlock(target)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    await hrd.insertAfterBlock(target, "<p></p>", null, true);
  } else if (e.key === "Backspace") {
    await handleBackspaceOnBlock(e, target);
  } else if (e.key === "Escape") {
    e.preventDefault();
    if (hrd.state.editDirty) await hrd.flushBlockSave(target);
    target.blur();
  }
}

function wireDocPointerEvents(docEl) {
  docEl.addEventListener("click", (e) => {
    const target = hrd.closestTopBlock(e.target);
    if (!target) return;
    hrd.positionGutter(target);
    if (hrd.isSimpleEditableBlock(target)) {
      hrd.enableBlockEditable(target);
      if (document.activeElement !== target) target.focus();
    }
  });
  docEl.addEventListener("dblclick", (e) => {
    const target = hrd.closestTopBlock(e.target);
    if (!target || hrd.isSimpleEditableBlock(target)) return;
    hrd.openBlockHtmlModal(target);
  });
  docEl.addEventListener("mouseover", (e) => {
    const target = hrd.closestTopBlock(e.target);
    if (!target) return;
    if (hrd.state.gutterTimer) clearTimeout(hrd.state.gutterTimer);
    hrd.positionGutter(target);
  });
  docEl.addEventListener("mouseleave", () => {
    hrd.state.gutterTimer = setTimeout(hrd.hideGutter, 380);
  });
}

function wireDocInteractions(docEl) {
  if (docEl.dataset.hrdWired) return;
  docEl.dataset.hrdWired = "1";
  wireDocPointerEvents(docEl);
  docEl.addEventListener("focusin", (e) => {
    const target = hrd.closestTopBlock(e.target);
    if (!target) return;
    hrd.state.activeEditId = target.getAttribute("data-hr-id");
    hrd.positionGutter(target);
  });
  docEl.addEventListener("focusout", (e) => {
    const target = hrd.closestTopBlock(e.target);
    if (
      target &&
      hrd.state.editDirty &&
      hrd.state.activeEditId === target.getAttribute("data-hr-id")
    ) {
      hrd.flushBlockSave(target);
    }
  });
  docEl.addEventListener("input", handleDocInput);
  docEl.addEventListener("keydown", handleDocKeydown);
  const obs = new MutationObserver(() => {
    hrd.syncAllEditables();
    hrd.ensureDefaultThemeLoaded();
    hrd.renderStats();
    if (hrd.state.sourceMode) hrd.renderSourcePane();
  });
  obs.observe(docEl, { childList: true, subtree: true });
}

function wireNotesAndTheme() {
  const notesEl = document.getElementById("hr-notes");
  if (notesEl && !notesEl.dataset.hrdWired) {
    notesEl.dataset.hrdWired = "1";
    const nObs = new MutationObserver(() => {
      hrd.enhanceAnnotationCards();
      const editorOpen = document
        .getElementById("hr-note-editor")
        ?.classList.contains("sidenote-editor--open");
      const diffOpen = document.getElementById("hr-diff")?.classList.contains("diff--open");
      const errTxt = (document.getElementById("hr-note-error")?.textContent || "").trim();
      if (editorOpen || diffOpen || errTxt) hrd.openNotesDrawer(true);
    });
    nObs.observe(notesEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  const themeSel = document.getElementById("hr-theme-select");
  if (themeSel && !themeSel.dataset.hrdWired) {
    themeSel.dataset.hrdWired = "1";
    themeSel.addEventListener("change", () => {
      hrd
        .persistStyle(themeSel.value)
        .catch((err) => hrd.showToast("写入主题失败：" + err.message, true));
    });
  }
}

function wireGlobalListeners() {
  if (document.body.dataset.hrdGlobalWired) return;
  document.body.dataset.hrdGlobalWired = "1";
  document.addEventListener("click", () => {
    hrd.closeFloatMenu();
    hrd.scheduleHideStatusbar();
  });
  window.addEventListener("mouseup", () => setTimeout(hrd.updateSelectionPopover, 20));
  window.addEventListener(
    "mousemove",
    (e) => {
      if (e.clientY >= window.innerHeight - 24) hrd.showStatusbar();
    },
    { passive: true },
  );
  window.addEventListener(
    "wheel",
    (e) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.closest("#hr-statusbar")) return;
      const canvas = document.getElementById("hr-canvas");
      if (canvas) canvas.scrollBy(0, e.deltaY);
    },
    { passive: true },
  );
}

function setupWorkbench() {
  if (checkUnauthorizedRecovery()) return;
  if (!document.getElementById("hr-root")) {
    hrd.ensureFallbackDragStrip();
    setTimeout(setupWorkbench, 40);
    return;
  }
  document.getElementById("hrd-fallback-drag")?.remove();
  if (hrd.readStorage(window.sessionStorage, "hrd_auto_outline") === "1") {
    hrd.removeStorage(window.sessionStorage, "hrd_auto_outline");
    hrd.state.activeSidebarTab = "toc";
  }
  if (hrd.isEmptyMode()) hrd.state.activeSidebarTab = "files";
  hrd.injectStyles();
  hrd.applyPrefs();
  hrd.ensureDefaultThemeLoaded();
  hrd.ensureOverlayTitlebar();
  hrd.buildSidebarEnhancements();
  hrd.buildNotesDrawerChrome();
  hrd.buildStatusbarEnhancements();
  hrd.ensureGutter();
  hrd.ensureSelectionPopover();
  hrd.updateDocBadge();
  hrd.renderEmptyState();
  hrd.syncAllEditables();
  hrd.renderStats();
  hrd.enhanceAnnotationCards();
  const docEl = document.getElementById("hr-doc");
  if (docEl) wireDocInteractions(docEl);
  wireNotesAndTheme();
  wireGlobalListeners();
}

function redirectIfDocMismatched(nextCtx) {
  const urlDoc = new URLSearchParams(window.location.search).get("doc");
  const syncKey = "hrd_doc_sync_" + window.location.port + "_" + String(nextCtx.docId || "");
  if (
    !nextCtx.docId ||
    !urlDoc ||
    urlDoc === nextCtx.docId ||
    hrd.readStorage(window.sessionStorage, syncKey)
  ) {
    return false;
  }
  hrd.writeStorage(window.sessionStorage, syncKey, "1");
  window.location.replace("/?doc=" + encodeURIComponent(nextCtx.docId));
  return true;
}

function applySyncedContext(nextCtx) {
  hrd.state.ctx = nextCtx;
  window.__HR_DESKTOP_CTX__ = nextCtx;
  hrd.applyPrefs();
  if (hrd.isEmptyMode()) {
    hrd.setSidebarMode("files");
    hrd.renderEmptyState();
  } else {
    hrd.renderSidebarHeader();
    const search = document.getElementById("hr-search");
    hrd.renderFilesPanel(search ? search.value : "");
  }
  hrd.updateDocBadge();
  const themeModalSel = document.getElementById("hrd-set-uitheme");
  if (themeModalSel) themeModalSel.innerHTML = hrd.buildUiThemeOptionsHtml();
}

window.__hrDesktopSync = (nextCtx) => {
  if (checkUnauthorizedRecovery()) return;
  setupWorkbench();
  if (!nextCtx || typeof nextCtx !== "object") return;
  if (redirectIfDocMismatched(nextCtx)) return;
  applySyncedContext(nextCtx);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupWorkbench);
} else {
  setupWorkbench();
}
window.addEventListener("load", setupWorkbench);
