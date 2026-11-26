// 桌面工作台共享状态、持久化偏好、网络请求与原生桥接。
const hrd = window.__hrd;

const PREFS_KEY = "hr_desktop_prefs_v3";
const DEFAULT_PREFS = {
  uiTheme: "light",
  bottomBarStyle: "floating",
  fontSize: 17,
  lineHeight: 1.75,
  maxWidth: "740px",
  showBlockIds: false,
  focusMode: false,
  defaultVisual: "atelier-editorial",
};

function readStorage(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function migrateLegacyPrefs(rawLegacy) {
  const old = JSON.parse(rawLegacy);
  return {
    ...DEFAULT_PREFS,
    fontSize: old.fontSize || DEFAULT_PREFS.fontSize,
    lineHeight: old.lineHeight || DEFAULT_PREFS.lineHeight,
    maxWidth: old.maxWidth || DEFAULT_PREFS.maxWidth,
    showBlockIds: Boolean(old.showBlockIds),
    focusMode: Boolean(old.focusMode),
    defaultVisual: old.defaultVisual || DEFAULT_PREFS.defaultVisual,
  };
}

function loadPrefs() {
  try {
    const raw = readStorage(window.localStorage, PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    const legacy = readStorage(window.localStorage, "hr_desktop_prefs_v2");
    if (legacy) return migrateLegacyPrefs(legacy);
    return { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(next) {
  writeStorage(window.localStorage, PREFS_KEY, JSON.stringify(next));
  hrd.state.prefs = next;
  return next;
}

function loadInitialSidebarTab() {
  const savedTab = readStorage(window.sessionStorage, "hrd_sidebar_tab");
  return savedTab === "toc" || savedTab === "files" ? savedTab : "files";
}

hrd.DEFAULT_PREFS = DEFAULT_PREFS;
hrd.state = {
  prefs: loadPrefs(),
  ctx: window.__HR_DESKTOP_CTX__ || {
    workspace: "",
    docId: "",
    files: [],
    tree: [],
    customThemes: [],
    isMacos: false,
  },
  activeSidebarTab: loadInitialSidebarTab(),
  searchOpen: false,
  sourceMode: false,
  notesOpen: false,
  activeEditId: null,
  editDirty: false,
  saveTimer: null,
  saveInFlight: Promise.resolve(),
  gutterBlock: null,
  gutterTimer: null,
  openMenuKind: null,
  sbHideTimer: null,
  toastTimer: null,
  expandedDirs: new Set(),
  lastAutoExpandedDoc: "",
  themeHydrated: false,
};

function currentDocId() {
  const q = new URLSearchParams(window.location.search).get("doc");
  if (q) return q;
  if (window.location.pathname.startsWith("/s/")) {
    return decodeURIComponent(window.location.pathname.slice(3));
  }
  return hrd.state.ctx.docId || "";
}

function isEmptyMode() {
  return !currentDocId();
}

function escapeHtmlText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function workspaceBaseName() {
  const parts = String(hrd.state.ctx.workspace || "")
    .split(/[/\\]/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "Vault";
}

function customThemesList() {
  return Array.isArray(hrd.state.ctx.customThemes) ? hrd.state.ctx.customThemes : [];
}

function showToast(msg, isError) {
  let el = document.getElementById("hr-desktop-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "hr-desktop-toast";
    document.body.appendChild(el);
  }
  el.textContent = String(msg);
  el.className = isError ? "show err" : "show";
  if (hrd.state.toastTimer) clearTimeout(hrd.state.toastTimer);
  hrd.state.toastTimer = setTimeout(() => {
    el.className = "";
  }, 2600);
}

function setSaveState(text) {
  const el = document.getElementById("hrd-save-state");
  if (el) el.textContent = text;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-hr-csrf": "1",
    },
    body: JSON.stringify(payload || {}),
  });
  const json = parseJsonSafe(await res.text());
  if (!res.ok) {
    throw new Error(json.message || json.code || "HTTP " + res.status);
  }
  return json;
}

function bridgeNavigate(path) {
  if (path === "/pick-folder") {
    removeStorage(window.sessionStorage, "hrd_sidebar_tab");
    removeStorage(window.sessionStorage, "hrd_auto_outline");
  }
  // 壳只认回带会话令牌的桥导航：文档/外部页伪造不了这些原生动作。
  const token = encodeURIComponent((hrd.state.ctx && hrd.state.ctx.bridgeToken) || "");
  const sep = path.indexOf("?") >= 0 ? "&" : "?";
  window.location.href = "http://hr-desktop.local" + path + sep + "t=" + token;
}

window.__hrDesktopToast = showToast;

Object.assign(hrd, {
  readStorage,
  writeStorage,
  removeStorage,
  savePrefs,
  currentDocId,
  isEmptyMode,
  escapeHtmlText,
  workspaceBaseName,
  customThemesList,
  showToast,
  setSaveState,
  apiPost,
  bridgeNavigate,
});
