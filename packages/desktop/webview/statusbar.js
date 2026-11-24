// 底部悬停状态栏、外观/导出/统计弹出菜单与导出命令分发。
const hrd = window.__hrd;

function runExportAction(kind) {
  if (hrd.isEmptyMode()) {
    if (kind === "reveal") hrd.bridgeNavigate("/reveal");
    else hrd.showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
    return;
  }
  const docId = hrd.currentDocId();
  if (kind === "print") {
    window.print();
    return;
  }
  if (kind === "reveal") {
    hrd.bridgeNavigate("/reveal?doc=" + encodeURIComponent(docId));
    return;
  }
  if (kind === "pdf" || kind === "png" || kind === "html") {
    hrd.showToast("正在生成 " + kind.toUpperCase() + "…");
    hrd.bridgeNavigate("/export-" + kind + "?doc=" + encodeURIComponent(docId));
  }
}

function showStatusbar() {
  if (hrd.state.sbHideTimer) {
    clearTimeout(hrd.state.sbHideTimer);
    hrd.state.sbHideTimer = null;
  }
  const sb = document.getElementById("hr-statusbar");
  if (sb) sb.classList.add("hrd-sb-visible");
}

function scheduleHideStatusbar() {
  if (hrd.state.sbHideTimer) clearTimeout(hrd.state.sbHideTimer);
  hrd.state.sbHideTimer = setTimeout(() => {
    const sb = document.getElementById("hr-statusbar");
    const menu = document.getElementById("hrd-float-menu");
    if (!sb || (menu && menu.classList.contains("open")) || sb.matches(":hover")) return;
    sb.classList.remove("hrd-sb-visible");
  }, 280);
}

function openAppearanceMenu(anchor) {
  const { prefs } = hrd.state;
  const themeBtns = [
    { id: "light", label: "纯净原生白（默认）" },
    { id: "paper", label: "暖纸典藏 (Paper)" },
    { id: "dark", label: "深色静谧 (Dark)" },
    ...hrd.customThemesList().map((t) => ({ id: t.id, label: t.name })),
  ]
    .map(
      (t) =>
        `<button type="button" class="hrd-dd-item" data-act="ui:${hrd.escapeHtmlText(t.id)}"><span>${hrd.escapeHtmlText(t.label)}</span><span>${prefs.uiTheme === t.id ? "✓" : ""}</span></button>`,
    )
    .join("");
  const nextBar = prefs.bottomBarStyle === "bar" ? "floating" : "bar";
  const barLabel = prefs.bottomBarStyle === "bar" ? "切换为悬浮毛玻璃底栏" : "切换为贴边通栏底栏";
  hrd.openFloatMenu(
    "sb-appearance",
    anchor,
    `
      <div class="hrd-menu-hdr">外观与主题</div>
      ${themeBtns}
      <div class="hrd-dd-sep"></div>
      <button type="button" class="hrd-dd-item" data-act="toggle-bar"><span>${barLabel}</span><span>底栏</span></button>
      <button type="button" class="hrd-dd-item" data-act="open-themes-dir"><span>打开自定义主题目录…</span><span>JSON</span></button>
    `,
    (act) => {
      if (!act) return;
      if (act === "open-themes-dir") hrd.bridgeNavigate("/open-themes-dir");
      else if (act === "toggle-bar") {
        hrd.savePrefs({ ...hrd.state.prefs, bottomBarStyle: nextBar });
        hrd.applyPrefs();
        showStatusbar();
      } else if (act.startsWith("ui:")) {
        hrd.savePrefs({ ...hrd.state.prefs, uiTheme: act.slice(3) });
        hrd.applyPrefs();
      }
    },
  );
}

function openExportMenu(anchor) {
  hrd.openFloatMenu(
    "sb-export",
    anchor,
    `
      <button type="button" class="hrd-dd-item" data-act="pdf"><span>导出带书签 PDF</span><span>PDF</span></button>
      <button type="button" class="hrd-dd-item" data-act="png"><span>导出高清 PNG 长图</span><span>PNG</span></button>
      <button type="button" class="hrd-dd-item" data-act="html"><span>导出自包含打印 HTML</span><span>HTML</span></button>
      <div class="hrd-dd-sep"></div>
      <button type="button" class="hrd-dd-item" data-act="print"><span>系统打印…</span><span>⌘P</span></button>
      <button type="button" class="hrd-dd-item" data-act="reveal"><span>在文件夹中显示</span><span>目录</span></button>
    `,
    (act) => runExportAction(act),
  );
}

function openStatsMenu(anchor) {
  const doc = document.getElementById("hr-doc");
  const rawText = (doc && doc.innerText) || "";
  const nonSpace = rawText.replace(/\s+/g, "").length;
  const blocks = hrd.contentBlocks().length;
  const mins = Math.max(1, Math.ceil(nonSpace / 400));
  hrd.openFloatMenu(
    "sb-stats",
    anchor,
    `
      <div class="hrd-menu-hdr">文档统计</div>
      <div class="hrd-dd-item" style="cursor:default;"><span>字符数（不含空白）</span><strong>${nonSpace}</strong></div>
      <div class="hrd-dd-item" style="cursor:default;"><span>字符数（含空白）</span><strong>${rawText.length}</strong></div>
      <div class="hrd-dd-item" style="cursor:default;"><span>结构节点数</span><strong>${blocks} 块</strong></div>
      <div class="hrd-dd-item" style="cursor:default;"><span>预计阅读时长</span><strong>约 ${mins} 分钟</strong></div>
    `,
    () => undefined,
  );
}

function buildStatusbarGroups(conn, hint) {
  const { ICONS } = hrd;
  const left = document.createElement("div");
  left.id = "hrd-sb-left-group";
  left.className = "hrd-sb-group";
  left.innerHTML = `
    <button type="button" class="hrd-sb-btn active" id="hrd-sb-left" title="显隐左侧边栏 (⌘⇧L)">${ICONS.sidebar}</button>
    <button type="button" class="hrd-sb-btn" id="hrd-sb-source" title="切换 HTML 源码模式 (⌘/)">${ICONS.source}<span>源码</span></button>
    <button type="button" class="hrd-sb-btn" id="hrd-sb-focus" title="专注模式 (⌘⇧F)">${ICONS.focus}<span>专注</span></button>
    <button type="button" class="hrd-sb-btn" id="hrd-sb-comp" title="插入结构化组件 (⌘⇧K)"><span>+ 组件</span></button>
    <span class="hrd-sb-sep"></span>
    <span id="hrd-save-state"></span>
  `;

  const mid = document.createElement("div");
  mid.id = "hrd-sb-mid-group";
  mid.className = "hrd-sb-group";
  if (conn) mid.appendChild(conn);
  const wordsBtn = document.createElement("button");
  wordsBtn.type = "button";
  wordsBtn.className = "hrd-sb-btn";
  wordsBtn.id = "hrd-sb-words";
  wordsBtn.title = "文档字数统计";
  wordsBtn.innerHTML = '<span id="hrd-sb-words-txt">0 字</span>';
  mid.appendChild(wordsBtn);
  if (hint) mid.appendChild(hint);

  const right = document.createElement("div");
  right.id = "hrd-sb-right";
  right.className = "hrd-sb-group";
  right.innerHTML = `
    <span class="hrd-sb-sep"></span>
    <button type="button" class="hrd-sb-btn" id="hrd-sb-notes" title="显隐批注栏 (⌘⇧R)">${ICONS.notes}<span>批注</span><span id="hrd-sb-notes-count" class="hrd-badge-count"></span></button>
    <button type="button" class="hrd-sb-btn" id="hrd-sb-appearance" title="切换外观主题与底栏样式">外观</button>
    <button type="button" class="hrd-sb-btn" id="hrd-sb-export" title="导出与打印">导出</button>
    <button type="button" class="hrd-sb-btn" id="hrd-sb-settings" title="偏好设置 (⌘,)">${ICONS.gear}</button>
  `;
  return { left, mid, right, wordsBtn };
}

function wireStatusbarEvents(left, right, wordsBtn) {
  left.querySelector("#hrd-sb-left").addEventListener("click", () => hrd.toggleLeftSidebar());
  left.querySelector("#hrd-sb-source").addEventListener("click", () => hrd.toggleSourceMode());
  left.querySelector("#hrd-sb-focus").addEventListener("click", () => {
    hrd.savePrefs({ ...hrd.state.prefs, focusMode: !hrd.state.prefs.focusMode });
    hrd.applyPrefs();
  });
  left.querySelector("#hrd-sb-comp").addEventListener("click", hrd.openComponentModal);
  right
    .querySelector("#hrd-sb-notes")
    .addEventListener("click", () => hrd.openNotesDrawer(!hrd.state.notesOpen));
  right.querySelector("#hrd-sb-settings").addEventListener("click", hrd.openSettingsModal);
  right.querySelector("#hrd-sb-appearance").addEventListener("click", (e) => {
    e.stopPropagation();
    openAppearanceMenu(e.currentTarget);
  });
  right.querySelector("#hrd-sb-export").addEventListener("click", (e) => {
    e.stopPropagation();
    openExportMenu(e.currentTarget);
  });
  wordsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openStatsMenu(e.currentTarget);
  });
}

function buildStatusbarEnhancements() {
  const sb = document.getElementById("hr-statusbar");
  if (!sb || document.getElementById("hrd-sb-left")) return;
  if (!document.getElementById("hrd-sb-hotzone")) {
    const hz = document.createElement("div");
    hz.id = "hrd-sb-hotzone";
    document.body.appendChild(hz);
    hz.addEventListener("mouseenter", showStatusbar);
    hz.addEventListener("mouseleave", scheduleHideStatusbar);
  }
  sb.addEventListener("mouseenter", showStatusbar);
  sb.addEventListener("mouseleave", scheduleHideStatusbar);
  const { left, mid, right, wordsBtn } = buildStatusbarGroups(
    document.getElementById("hr-conn"),
    document.getElementById("hr-hint"),
  );
  sb.prepend(left);
  sb.appendChild(mid);
  sb.appendChild(right);
  wireStatusbarEvents(left, right, wordsBtn);
}

Object.assign(hrd, {
  runExportAction,
  showStatusbar,
  scheduleHideStatusbar,
  buildStatusbarEnhancements,
});
