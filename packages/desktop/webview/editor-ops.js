// 块级补丁队列、原地保存、Markdown 前缀转换、插入/删除块与撤销。
const hrd = window.__hrd;

const MARKDOWN_PREFIX_RULES = [
  { re: /^# ([\s\S]*)$/, tag: "h1" },
  { re: /^## ([\s\S]*)$/, tag: "h2" },
  { re: /^### ([\s\S]*)$/, tag: "h3" },
  { re: /^#### ([\s\S]*)$/, tag: "h4" },
  { re: /^> ([\s\S]*)$/, tag: "blockquote" },
];

async function patchNode(targetId, action, fragment) {
  const docId = hrd.currentDocId();
  if (!docId || !targetId) {
    hrd.showToast("未选中可编辑节点", true);
    return null;
  }
  const body = { docId, targetId, action };
  if (action !== "delete") body.fragment = fragment;
  return await hrd.apiPost("/api/patch", body);
}

function enqueuePatch(fn) {
  hrd.state.saveInFlight = hrd.state.saveInFlight.then(fn, fn);
  return hrd.state.saveInFlight;
}

function clearSavedLabelLater() {
  setTimeout(() => {
    const cur = document.getElementById("hrd-save-state");
    if (cur && cur.textContent === "已保存") cur.textContent = "";
  }, 1600);
}

function clearPendingSaveTimer() {
  if (hrd.state.saveTimer) {
    clearTimeout(hrd.state.saveTimer);
    hrd.state.saveTimer = null;
  }
}

function flushBlockSave(el, tagOverride) {
  if (hrd.isEmptyMode() || !el || !el.isConnected) return Promise.resolve(null);
  const id = el.getAttribute("data-hr-id");
  if (!id || (!hrd.state.editDirty && !tagOverride)) return Promise.resolve(null);
  hrd.state.editDirty = false;
  clearPendingSaveTimer();
  const fragment = hrd.serializeBlockHtml(el, tagOverride);
  hrd.setSaveState("保存中…");
  return enqueuePatch(async () => {
    try {
      const res = await patchNode(id, "replace", fragment);
      hrd.setSaveState("已保存");
      clearSavedLabelLater();
      return res;
    } catch (err) {
      hrd.setSaveState("");
      hrd.showToast("保存失败：" + err.message, true);
      return null;
    }
  });
}

async function convertBlockTag(el, newTag) {
  if (hrd.isEmptyMode()) {
    hrd.showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
    return;
  }
  const target = el || hrd.activeBlockEl();
  const id = target && target.getAttribute("data-hr-id");
  if (!target || !id) return;
  if (!hrd.isSimpleEditableBlock(target)) {
    hrd.showToast("结构化组件请使用 HTML 源码编辑", true);
    return;
  }
  const text = (target.textContent || "").trim();
  const fragment = "<" + newTag + ">" + hrd.escapeHtmlText(text) + "</" + newTag + ">";
  hrd.state.editDirty = false;
  hrd.setSaveState("保存中…");
  await enqueuePatch(async () => {
    try {
      await patchNode(id, "replace", fragment);
      hrd.setSaveState("已保存");
      hrd.focusBlockById(id, true, 30, newTag);
    } catch (err) {
      hrd.setSaveState("");
      hrd.showToast("转换失败：" + err.message, true);
    }
  });
}

function applyMarkdownPrefix(el, rule, rest) {
  const id = el.getAttribute("data-hr-id");
  hrd.state.editDirty = false;
  clearPendingSaveTimer();
  el.textContent = rest;
  const fragment = "<" + rule.tag + ">" + hrd.escapeHtmlText(rest) + "</" + rule.tag + ">";
  enqueuePatch(async () => {
    try {
      await patchNode(id, "replace", fragment);
      hrd.focusBlockById(id, true, 30, rule.tag);
    } catch (err) {
      hrd.showToast("转换失败：" + err.message, true);
    }
  });
}

function tryMarkdownPrefix(el) {
  if (el.tagName.toLowerCase() !== "p") return false;
  const raw = (el.textContent || "").replace(/\u00a0/g, " ");
  for (const rule of MARKDOWN_PREFIX_RULES) {
    const m = rule.re.exec(raw);
    if (m) {
      applyMarkdownPrefix(el, rule, m[1] || "");
      return true;
    }
  }
  return false;
}

async function insertAfterBlock(el, fragment, label, focusNew) {
  if (hrd.isEmptyMode()) {
    hrd.showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
    return null;
  }
  const target = el || hrd.activeBlockEl();
  if (!target) {
    hrd.showToast("当前文档没有可插入位置的块", true);
    return null;
  }
  const targetId = target.getAttribute("data-hr-id");
  if (hrd.state.editDirty && hrd.state.activeEditId === targetId) {
    await flushBlockSave(target);
  }
  return await enqueuePatch(async () => {
    try {
      const res = await patchNode(targetId, "insert_after", fragment);
      if (label) hrd.showToast("已插入：" + label);
      const createdId = res && Array.isArray(res.newIds) && res.newIds[0];
      if (focusNew && createdId) hrd.focusBlockById(createdId, false, 35);
      return res;
    } catch (err) {
      hrd.showToast("插入失败：" + err.message, true);
      return null;
    }
  });
}

async function deleteBlock(el) {
  if (hrd.isEmptyMode()) {
    hrd.showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
    return;
  }
  const target = el || hrd.activeBlockEl();
  if (!target) return;
  const all = hrd.contentBlocks();
  if (all.length <= 1) {
    hrd.showToast("至少保留一个正文节点", true);
    return;
  }
  const idx = all.indexOf(target);
  const prev = idx > 0 ? all[idx - 1] : all[idx + 1];
  const prevId = prev ? prev.getAttribute("data-hr-id") : null;
  const targetId = target.getAttribute("data-hr-id");
  hrd.state.editDirty = false;
  hrd.state.activeEditId = null;
  await enqueuePatch(async () => {
    try {
      await patchNode(targetId, "delete");
      if (prevId) hrd.focusBlockById(prevId, true, 20);
    } catch (err) {
      hrd.showToast("删除失败：" + err.message, true);
    }
  });
}

async function undoDocument() {
  if (hrd.isEmptyMode()) {
    hrd.showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
    return;
  }
  const docId = hrd.currentDocId();
  if (!docId) return;
  try {
    await hrd.apiPost("/api/doc/" + encodeURIComponent(docId) + "/undo", {});
    hrd.showToast("已撤销上次文档快照");
  } catch (err) {
    hrd.showToast("无法撤销：" + err.message, true);
  }
}

async function persistStyle(visualId) {
  const docId = hrd.currentDocId();
  if (!docId || !visualId) return;
  await hrd.apiPost("/api/style", { docId, visualId });
  hrd.showToast("已应用并写入视觉主题：" + visualId);
}

Object.assign(hrd, {
  patchNode,
  flushBlockSave,
  convertBlockTag,
  tryMarkdownPrefix,
  insertAfterBlock,
  deleteBlock,
  undoDocument,
  persistStyle,
});
