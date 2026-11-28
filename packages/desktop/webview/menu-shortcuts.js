// 原生菜单动作分发与捕获阶段快捷键处理。
const hrd = window.__hrd;

const MENU_ACTIONS = {
  "open-file": () => hrd.openFileSwitcherModal(),
  "pick-file": () => hrd.bridgeNavigate("/pick-file"),
  "pick-folder": () => hrd.bridgeNavigate("/pick-folder"),
  "new-file": () => hrd.openNewDocModal(),
  "open-themes-dir": () => hrd.bridgeNavigate("/open-themes-dir"),
  "reload-themes": () => hrd.bridgeNavigate("/reload-themes"),
  "save-as-template": () => hrd.openSaveAsTemplateModal(),
  "save-doc": () => {
    const active = hrd.closestTopBlock(document.activeElement) || hrd.activeBlockEl();
    hrd.flushBlockSave(active).then(() => hrd.showToast("文档已保存"));
  },
  settings: () => hrd.openSettingsModal(),
  welcome: () => hrd.bridgeNavigate("/welcome"),
  help: () => hrd.openHelpModal(),
  "edit-block": () => hrd.openBlockHtmlModal(hrd.activeBlockEl()),
  "insert-para": () => hrd.insertAfterBlock(hrd.activeBlockEl(), "<p></p>", null, true),
  "insert-comp": () => hrd.openComponentModal(),
  "delete-block": () => hrd.deleteBlock(hrd.activeBlockEl()),
  undo: () => hrd.undoDocument(),
  "toggle-source": () => hrd.toggleSourceMode(),
  "toggle-left": () => hrd.toggleLeftSidebar(),
  "toggle-right": () => hrd.openNotesDrawer(!hrd.state.notesOpen),
  "toggle-focus": () => {
    hrd.savePrefs({ ...hrd.state.prefs, focusMode: !hrd.state.prefs.focusMode });
    hrd.applyPrefs();
  },
  "toggle-immersive": () => hrd.toggleImmersive(),
  "export-pdf": () => hrd.runExportAction("pdf"),
  "export-png": () => hrd.runExportAction("png"),
  "export-html": () => hrd.runExportAction("html"),
  print: () => hrd.runExportAction("print"),
  reveal: () => hrd.runExportAction("reveal"),
};

function applyThemeMenuAction(id) {
  const sel = document.getElementById("hr-theme-select");
  if (sel) {
    sel.value = id;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    hrd.persistStyle(id).catch((err) => hrd.showToast(err.message, true));
  }
}

window.__hrMenuAction = (action) => {
  const direct = MENU_ACTIONS[action];
  if (direct) {
    direct();
    return;
  }
  if (action.startsWith("tag:")) hrd.convertBlockTag(hrd.activeBlockEl(), action.slice(4));
  else if (action.startsWith("comp:")) {
    const comp = hrd.COMPONENTS.find((c) => c.id === action.slice(5));
    if (comp) hrd.insertAfterBlock(hrd.activeBlockEl(), comp.html, comp.label, false);
  } else if (action.startsWith("theme:")) {
    applyThemeMenuAction(action.slice(6));
  } else if (action.startsWith("ui:")) {
    hrd.savePrefs({ ...hrd.state.prefs, uiTheme: action.slice(3) });
    hrd.applyPrefs();
  }
};

function isEditableFocus() {
  const el = document.activeElement;
  if (!(el instanceof Element)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

const MOD_SHORTCUTS = {
  o: () => hrd.openFileSwitcherModal(),
  // ⌘K opens the library search panel hosted by the reader page (D61). ⌘⇧K stays
  // on components — the shift table wins when shift is held (see handleModShortcut).
  k: () => hrd.openLibrarySearch(),
  n: () => hrd.openNewDocModal(),
  ",": () => hrd.openSettingsModal(),
  s: () => window.__hrMenuAction("save-doc"),
  e: () => hrd.openBlockHtmlModal(hrd.activeBlockEl()),
  "/": () => hrd.toggleSourceMode(),
  p: () => window.print(),
};

const SHIFT_MOD_SHORTCUTS = {
  k: () => hrd.openComponentModal(),
  l: () => hrd.toggleLeftSidebar(),
  r: () => hrd.openNotesDrawer(!hrd.state.notesOpen),
  f: () => window.__hrMenuAction("toggle-focus"),
};

function handlePlainKeydown(e, editable) {
  if (e.key !== "/" || editable) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  hrd.toggleLeftSidebar(true);
  hrd.toggleSearchBox(true);
}

function handleModShortcut(e, editable) {
  const k = e.key.toLowerCase();
  // The shift table wins first: ⌘K and ⌘⇧K are both valid bindings — whichever
  // was pressed takes it (keys absent from the shift table, like ⌘⇧O, still fall
  // through to MOD_SHORTCUTS).
  const handler = (e.shiftKey ? SHIFT_MOD_SHORTCUTS[k] : undefined) || MOD_SHORTCUTS[k];
  if (handler) {
    e.preventDefault();
    handler();
    return;
  }
  if (k === "z" && (e.shiftKey || !editable)) {
    e.preventDefault();
    hrd.undoDocument();
  }
}

function handleShortcutKeydown(e) {
  const editable = isEditableFocus();
  if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    handlePlainKeydown(e, editable);
    return;
  }
  if (e.metaKey || e.ctrlKey) handleModShortcut(e, editable);
}

window.addEventListener("keydown", handleShortcutKeydown, true);
