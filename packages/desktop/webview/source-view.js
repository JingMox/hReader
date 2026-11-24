// HTML 源码视图、单块 HTML 弹窗、字数与批注角标统计、批注交互增强。
const hrd = window.__hrd;

function renderSourceCardHtml(el) {
  const { escapeHtmlText } = hrd;
  const id = el.getAttribute("data-hr-id") || "";
  const clone = hrd.cleanBlockClone(el);
  const comp = el.getAttribute("data-hr-component");
  const compSuffix = comp ? " · " + escapeHtmlText(comp) : "";
  return `
    <div class="hrd-src-card" data-src-id="${escapeHtmlText(id)}">
      <div class="hrd-src-head">
        <span>&lt;${escapeHtmlText(el.tagName.toLowerCase())}&gt; · ${escapeHtmlText(id)}${compSuffix}</span>
        <button type="button" class="hrd-btn hrd-src-save" style="height:22px;padding:0 8px;font-size:11px;">保存 ⌘Enter</button>
      </div>
      <textarea class="hrd-src-ta">${escapeHtmlText(clone.outerHTML)}</textarea>
    </div>
  `;
}

function renderSourcePane() {
  const pane = document.getElementById("hrd-source-pane");
  if (!pane || !hrd.state.sourceMode) return;
  const cards = hrd.contentBlocks().map(renderSourceCardHtml).join("");
  pane.innerHTML = `
    <div class="hrd-src-banner">
      <span>HTML 源码视图（修改单个节点后点击「保存」，按 Cmd+/ 返回 Typora 排版视图）</span>
      <button type="button" class="hrd-btn" id="hrd-src-exit">返回排版视图</button>
    </div>
    ${cards}
  `;
}

async function handleSourcePaneClick(e) {
  if (e.target.closest("#hrd-src-exit")) {
    toggleSourceMode(false);
    return;
  }
  const saveBtn = e.target.closest(".hrd-src-save");
  if (!saveBtn) return;
  const card = saveBtn.closest("[data-src-id]");
  const id = card && card.getAttribute("data-src-id");
  const ta = card && card.querySelector(".hrd-src-ta");
  if (!id || !ta) return;
  try {
    await hrd.patchNode(id, "replace", ta.value.trim());
    hrd.showToast("源码已保存：" + id);
  } catch (err) {
    hrd.showToast("保存失败：" + err.message, true);
  }
}

function handleSourcePaneKeydown(e) {
  if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
  const card = e.target.closest("[data-src-id]");
  const btn = card && card.querySelector(".hrd-src-save");
  if (btn) {
    e.preventDefault();
    btn.click();
  }
}

function createSourcePane(canvas) {
  const pane = document.createElement("div");
  pane.id = "hrd-source-pane";
  canvas.appendChild(pane);
  pane.addEventListener("click", handleSourcePaneClick);
  pane.addEventListener("keydown", handleSourcePaneKeydown);
  return pane;
}

function toggleSourceMode(force) {
  if (hrd.isEmptyMode()) {
    hrd.showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
    return;
  }
  hrd.state.sourceMode = force !== undefined ? Boolean(force) : !hrd.state.sourceMode;
  const docEl = document.getElementById("hr-doc");
  const canvas = document.getElementById("hr-canvas");
  let pane = document.getElementById("hrd-source-pane");
  if (!pane && canvas) pane = createSourcePane(canvas);
  if (docEl) docEl.style.display = hrd.state.sourceMode ? "none" : "";
  if (pane) pane.classList.toggle("open", hrd.state.sourceMode);
  const btn = document.getElementById("hrd-sb-source");
  if (btn) btn.classList.toggle("active", hrd.state.sourceMode);
  if (hrd.state.sourceMode) {
    hrd.hideGutter();
    renderSourcePane();
  }
}

function wireBlockHtmlModal(m, id, initialHtml) {
  const ta = m.querySelector("#hrd-mod-html-ta");
  ta.value = initialHtml;
  ta.focus();
  const save = async () => {
    try {
      await hrd.patchNode(id, "replace", ta.value.trim());
      hrd.closeModal();
      hrd.showToast("已保存 HTML 修改");
    } catch (err) {
      hrd.showToast("保存失败：" + err.message, true);
    }
  };
  m.querySelector("#hrd-mod-html-save").addEventListener("click", save);
  m.querySelector("#hrd-mod-html-cancel").addEventListener("click", hrd.closeModal);
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
  });
}

function openBlockHtmlModal(el) {
  if (hrd.isEmptyMode()) {
    hrd.showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
    return;
  }
  const target = el || hrd.activeBlockEl();
  if (!target) {
    hrd.showToast("请先点击一个块", true);
    return;
  }
  const id = target.getAttribute("data-hr-id");
  const clone = hrd.cleanBlockClone(target);
  const m = hrd.ensureModal(
    "html-edit",
    "编辑节点 HTML · " + (id || ""),
    `
      <div style="font-size:12px;color:var(--hr-muted);margin-bottom:8px;">直接修改完整元素源码，保存后按文档规范重新注入 id 并保留历史快照。</div>
      <textarea id="hrd-mod-html-ta" class="hrd-src-ta" style="min-height:180px;"></textarea>
    `,
    `
      <button type="button" class="hrd-btn" id="hrd-mod-html-cancel">取消</button>
      <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-mod-html-save">保存 ⌘Enter</button>
    `,
  );
  wireBlockHtmlModal(m, id, clone.outerHTML);
}

function renderStats() {
  const doc = document.getElementById("hr-doc");
  const wordsEl = document.getElementById("hrd-sb-words-txt");
  const notesBadge = document.getElementById("hrd-sb-notes-count");
  if (doc && wordsEl) {
    const text = (doc.innerText || "").replace(/\s+/g, "");
    wordsEl.textContent = text.length + " 字";
  }
  if (notesBadge) {
    const pending = document.querySelectorAll(
      '#hr-notes-pending [data-hr-annotation][data-hr-status="pending"]',
    ).length;
    notesBadge.textContent = pending > 0 ? String(pending) : "";
  }
}

function createResolveButton(anId) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hrd-resolve-btn";
  btn.textContent = "✓ 解决并归档";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const docId = hrd.currentDocId();
      await hrd.apiPost(
        "/api/doc/" +
          encodeURIComponent(docId) +
          "/annotations/" +
          encodeURIComponent(anId) +
          "/resolve",
        { docId, resolutionNote: "桌面端已确认" },
      );
      hrd.showToast("批注已归档");
    } catch (err) {
      hrd.showToast("归档失败：" + err.message, true);
    }
  });
  return btn;
}

function enhanceAnnotationCards() {
  const cards = document.querySelectorAll(
    '#hr-notes-pending [data-hr-annotation][data-hr-status="pending"]',
  );
  for (const card of cards) {
    if (card.querySelector(".hrd-resolve-btn")) continue;
    const anId = card.getAttribute("data-hr-annotation");
    if (anId) card.appendChild(createResolveButton(anId));
  }
  renderStats();
}

function triggerWholeBlockNote(el) {
  if (el) el.click();
  hrd.openNotesDrawer(true);
  setTimeout(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    const draft = document.getElementById("hr-note-draft");
    if (draft) draft.focus();
  }, 20);
}

function ensureSelectionPopover() {
  if (document.getElementById("hrd-sel-pop")) return;
  const pop = document.createElement("button");
  pop.id = "hrd-sel-pop";
  pop.type = "button";
  pop.textContent = "💬 批注选区";
  pop.addEventListener("mousedown", (e) => e.preventDefault());
  pop.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.classList.remove("open");
    hrd.openNotesDrawer(true);
    const noteBtn = document.getElementById("hr-note-btn");
    if (noteBtn && !noteBtn.hasAttribute("hidden")) noteBtn.click();
    setTimeout(() => {
      const draft = document.getElementById("hr-note-draft");
      if (draft) draft.focus();
    }, 30);
  });
  document.body.appendChild(pop);
}

function getValidSelectionRange() {
  const sel = window.getSelection();
  const noteBtn = document.getElementById("hr-note-btn");
  if (!sel || sel.isCollapsed || !noteBtn || noteBtn.hasAttribute("hidden")) return null;
  const docEl = document.getElementById("hr-doc");
  if (!docEl || !sel.anchorNode || !docEl.contains(sel.anchorNode)) return null;
  return sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
}

function updateSelectionPopover() {
  const pop = document.getElementById("hrd-sel-pop");
  if (!pop) return;
  const range = getValidSelectionRange();
  if (!range) {
    pop.classList.remove("open");
    return;
  }
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  pop.style.left = Math.min(Math.max(12, rect.left), window.innerWidth - 120) + "px";
  pop.style.top = Math.max(8, rect.top - 34) + "px";
  pop.classList.add("open");
}

Object.assign(hrd, {
  renderSourcePane,
  toggleSourceMode,
  openBlockHtmlModal,
  renderStats,
  enhanceAnnotationCards,
  triggerWholeBlockNote,
  ensureSelectionPopover,
  updateSelectionPopover,
});
