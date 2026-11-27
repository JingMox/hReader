// 偏好设置、新建文档、快速切换、组件面板、帮助指南与导出分发。
const hrd = window.__hrd;

function buildTypographyFieldsHtml(prefs, themeOpts) {
  const fontOpts = [15, 16, 17, 18, 19, 20, 22]
    .map((s) => `<option value="${s}" ${prefs.fontSize === s ? "selected" : ""}>${s} px</option>`)
    .join("");
  const lhOpts = [1.55, 1.65, 1.75, 1.85, 2.0]
    .map(
      (v) =>
        `<option value="${v}" ${Number(prefs.lineHeight) === v ? "selected" : ""}>${v}</option>`,
    )
    .join("");
  return `
    <div class="hrd-field"><span>正文字号（px）</span><select id="hrd-set-fontsize">${fontOpts}</select></div>
    <div class="hrd-field"><span>正文行距</span><select id="hrd-set-lh">${lhOpts}</select></div>
    <div class="hrd-field">
      <span>阅读栏最大宽度</span>
      <select id="hrd-set-width">
        <option value="640px" ${prefs.maxWidth === "640px" ? "selected" : ""}>紧凑 640px</option>
        <option value="740px" ${prefs.maxWidth === "740px" ? "selected" : ""}>标准 740px（Typora 默认）</option>
        <option value="880px" ${prefs.maxWidth === "880px" ? "selected" : ""}>宽版 880px</option>
        <option value="100%" ${prefs.maxWidth === "100%" ? "selected" : ""}>铺满画布</option>
      </select>
    </div>
    <div class="hrd-field"><span>文档排版主题</span><select id="hrd-set-visual">${themeOpts}</select></div>
    <div class="hrd-field"><span>专注模式（淡化非当前段）</span><input type="checkbox" id="hrd-set-focus" ${prefs.focusMode ? "checked" : ""}/></div>
    <div class="hrd-field"><span>左侧边缘显示节点 ID 标号</span><input type="checkbox" id="hrd-set-ids" ${prefs.showBlockIds ? "checked" : ""}/></div>
  `;
}

function buildSettingsBodyHtml(themeOpts) {
  const { prefs, ctx } = hrd.state;
  return `
    <div class="hrd-field"><span>外观主题</span><select id="hrd-set-uitheme">${hrd.buildUiThemeOptionsHtml()}</select></div>
    <div class="hrd-field">
      <div>
        <div>自定义主题配置</div>
        <div style="font-size:11px;color:var(--hr-muted);margin-top:2px;">编写 ~/.hreader/themes/*.json 或工作区 .hreader/themes/*.json</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button type="button" class="hrd-btn" id="hrd-set-open-themes">打开目录…</button>
        <button type="button" class="hrd-btn" id="hrd-set-reload-themes">重新加载</button>
      </div>
    </div>
    <div class="hrd-field">
      <span>底部工具栏样式（悬停显示）</span>
      <select id="hrd-set-barstyle">
        <option value="floating" ${prefs.bottomBarStyle !== "bar" ? "selected" : ""}>悬浮毛玻璃胶囊</option>
        <option value="bar" ${prefs.bottomBarStyle === "bar" ? "selected" : ""}>贴边通栏平滑滑出</option>
      </select>
    </div>
    ${buildTypographyFieldsHtml(prefs, themeOpts)}
    <div class="hrd-field"><span>文件树显示所有文件（含页面资源与非 HTML 文件）</span><input type="checkbox" id="hrd-set-showall" ${prefs.showAllFiles ? "checked" : ""}/></div>
    <div class="hrd-field" style="border-bottom:none;">
      <span>笔记库根目录（工作区）</span>
      <button type="button" class="hrd-btn" id="hrd-set-pick-ws">更改根目录…</button>
    </div>
    <div style="font-size:11.5px;color:var(--hr-muted);word-break:break-all;">${hrd.escapeHtmlText(ctx.workspace || "")}</div>
    <div class="hrd-menu-hdr" style="margin-top:14px;">外来 HTML 权限（对所有文档生效）</div>
    <div class="hrd-field">
      <span>运行脚本</span>
      <select id="hrd-set-perm-scripts" disabled>${buildModeOptionsHtml("per-doc")}</select>
    </div>
    <div class="hrd-field">
      <span>联网加载资源</span>
      <select id="hrd-set-perm-network" disabled>${buildModeOptionsHtml("per-doc")}</select>
    </div>
    <div class="hrd-menu-hdr" style="margin-top:14px;">文档模板</div>
    <div class="hrd-field">
      <div>
        <div>模板目录</div>
        <div style="font-size:11px;color:var(--hr-muted);margin-top:2px;">~/.hreader/templates 与 工作区 .hreader/templates</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button type="button" class="hrd-btn" id="hrd-set-tpl-open-user">打开用户目录…</button>
        <button type="button" class="hrd-btn" id="hrd-set-tpl-open-ws">打开工作区目录…</button>
      </div>
    </div>
    <div id="hrd-tpl-section"><div style="font-size:12px;color:var(--hr-muted);padding:4px 0;">正在加载模板…</div></div>
  `;
}

// 三选一与 core 的 PermissionMode 一一对应；先禁用渲染，GET 回来再放开，避免把
// 占位值当真值误存。
function buildModeOptionsHtml(current) {
  const opts = [
    ["per-doc", "逐个文档开关（默认）"],
    ["allow", "全部允许"],
    ["deny", "全部禁止"],
  ];
  return opts
    .map(
      ([v, label]) => `<option value="${v}" ${v === current ? "selected" : ""}>${label}</option>`,
    )
    .join("");
}

async function hydratePermissionSelects(m) {
  const scripts = m.querySelector("#hrd-set-perm-scripts");
  const network = m.querySelector("#hrd-set-perm-network");
  if (!scripts || !network) return;
  try {
    const res = await fetch("/api/permissions", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    const json = JSON.parse(await res.text());
    const modes = json && typeof json === "object" ? json.modes : undefined;
    if (!res.ok || typeof modes !== "object" || modes === null) {
      throw new Error(`HTTP ${res.status}`);
    }
    // Any string would "pass" a typeof check but leave the select with no
    // matching option; an out-of-range mode must take the same lock-up path
    // as a malformed payload rather than POST "" back to the server.
    const VALID = new Set(["per-doc", "allow", "deny"]);
    if (!VALID.has(modes.scripts) || !VALID.has(modes.network)) {
      throw new Error("unexpected modes payload");
    }
    scripts.value = modes.scripts;
    network.value = modes.network;
    scripts.disabled = false;
    network.disabled = false;
  } catch (err) {
    // 读不到就锁死在禁用态：宁可这一栏不可用，也不能把"逐个文档"假值写回去。
    hrd.showToast("读取外来文档权限设置失败：" + (err && err.message ? err.message : err), true);
  }
}

async function applySettingsFromModal(m) {
  const visual = m.querySelector("#hrd-set-visual").value;
  const permScripts = m.querySelector("#hrd-set-perm-scripts");
  const permNetwork = m.querySelector("#hrd-set-perm-network");
  hrd.savePrefs({
    uiTheme: m.querySelector("#hrd-set-uitheme").value || "light",
    bottomBarStyle: m.querySelector("#hrd-set-barstyle").value,
    fontSize: Number(m.querySelector("#hrd-set-fontsize").value),
    lineHeight: Number(m.querySelector("#hrd-set-lh").value),
    maxWidth: m.querySelector("#hrd-set-width").value,
    focusMode: m.querySelector("#hrd-set-focus").checked,
    showBlockIds: m.querySelector("#hrd-set-ids").checked,
    defaultVisual: visual,
    showAllFiles: m.querySelector("#hrd-set-showall").checked,
  });
  // 全局权限不落本地 prefs：服务端是唯一真相源，这里直接写 daemon。
  // GET 没回来时两个框仍是禁用态——只写"放开过"的值，不把占位写回去。
  if (permScripts && permNetwork && !permScripts.disabled && !permNetwork.disabled) {
    try {
      await hrd.apiPost("/api/permissions", {
        scripts: permScripts.value,
        network: permNetwork.value,
      });
    } catch (err) {
      hrd.showToast("外来文档权限保存失败：" + err.message, true);
    }
  }
  hrd.applyPrefs();
  // "显示所有文件"立即生效：不必重开窗口才能看到资源文件。
  const searchEl = document.getElementById("hr-search");
  hrd.renderFilesPanel(searchEl ? searchEl.value : "");
  hrd.closeModal();
  const sel = document.getElementById("hr-theme-select");
  if (sel && visual && sel.value !== visual) {
    sel.value = visual;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await hrd.persistStyle(visual).catch(() => null);
  } else {
    hrd.showToast("偏好设置已保存");
  }
}

function openSettingsModal() {
  const themes = [...document.querySelectorAll("#hr-theme-select option")].map((o) => o.value);
  const { defaultVisual } = hrd.state.prefs;
  const themeOpts = (themes.length ? themes : ["atelier-editorial"])
    .map(
      (t) =>
        `<option value="${hrd.escapeHtmlText(t)}" ${t === defaultVisual ? "selected" : ""}>${hrd.escapeHtmlText(t)}</option>`,
    )
    .join("");
  const m = hrd.ensureModal(
    "settings",
    "偏好设置",
    buildSettingsBodyHtml(themeOpts),
    `
      <button type="button" class="hrd-btn" id="hrd-set-reset">恢复默认</button>
      <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-set-done">完成</button>
    `,
  );
  m.querySelector("#hrd-set-open-themes").addEventListener("click", () => {
    hrd.bridgeNavigate("/open-themes-dir");
  });
  m.querySelector("#hrd-set-reload-themes").addEventListener("click", () => {
    hrd.bridgeNavigate("/reload-themes");
    setTimeout(() => {
      const sel = document.getElementById("hrd-set-uitheme");
      if (sel) sel.innerHTML = hrd.buildUiThemeOptionsHtml();
    }, 140);
  });
  m.querySelector("#hrd-set-pick-ws").addEventListener("click", () => {
    hrd.closeModal();
    hrd.bridgeNavigate("/pick-folder");
  });
  m.querySelector("#hrd-set-reset").addEventListener("click", () => {
    hrd.savePrefs({ ...hrd.DEFAULT_PREFS });
    hrd.applyPrefs();
    const searchEl = document.getElementById("hr-search");
    hrd.renderFilesPanel(searchEl ? searchEl.value : "");
    hrd.closeModal();
    // 服务端的两个全局档也要跟着回"逐个文档"，否则本地清了远端还在接管开关。
    hrd
      .apiPost("/api/permissions", { scripts: "per-doc", network: "per-doc" })
      .then(() => hrd.showToast("已恢复默认设置"))
      .catch((err) => hrd.showToast("权限设置复位失败：" + err.message, true));
  });
  m.querySelector("#hrd-set-done").addEventListener("click", () => applySettingsFromModal(m));
  m.querySelector("#hrd-set-tpl-open-user").addEventListener("click", () => {
    hrd.bridgeNavigate("/template-open-dir?scope=user");
  });
  m.querySelector("#hrd-set-tpl-open-ws").addEventListener("click", () => {
    hrd.bridgeNavigate("/template-open-dir?scope=workspace");
  });
  hydratePermissionSelects(m);
  hrd.requestTemplates();
}

// The new-doc select and the settings section share one pushed list
// (`__hrTemplateResult`); both renderers tolerate "still loading" and "failed".
function renderNewDocTemplateFields() {
  const sel = document.getElementById("hrd-new-template");
  if (!sel) return;
  const hint = document.getElementById("hrd-new-template-hint");
  const tpl = hrd.state.templates;
  const previous = sel.value;
  sel.innerHTML = '<option value="">空白文档（默认）</option>';
  if (tpl.status === "ready") {
    for (const t of tpl.list) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = `${t.name || t.id}（${t.source}）`;
      sel.appendChild(opt);
    }
    const wanted = hrd.state.ctx.defaultTemplate;
    sel.value = wanted && tpl.list.some((t) => t.id === wanted) ? wanted : previous;
  }
  if (hint) {
    hint.textContent =
      tpl.status === "error"
        ? "模板列表加载失败，仍可创建空白文档"
        : tpl.status === "ready" && tpl.diagnostics.length
          ? `${tpl.diagnostics.length} 个模板未能加载，详见偏好设置`
          : "";
  }
}

function openDeleteTemplateModal(id) {
  const m = hrd.ensureModal(
    "tpl-delete",
    "删除模板",
    `<div style="font-size:13px;">确认删除模板 <code>${hrd.escapeHtmlText(id)}</code>？目录将移入废纸篓。</div>`,
    `
      <button type="button" class="hrd-btn" id="hrd-tpldel-cancel">取消</button>
      <button type="button" class="hrd-btn" id="hrd-tpldel-ok" style="color:#a3341a;">删除</button>
    `,
  );
  const backToSettings = () => {
    hrd.closeModal();
    hrd.openSettingsModal();
  };
  m.querySelector("#hrd-tpldel-cancel").addEventListener("click", backToSettings);
  m.querySelector("#hrd-tpldel-ok").addEventListener("click", () => {
    hrd.closeModal();
    hrd.bridgeNavigate("/template-delete?id=" + encodeURIComponent(id));
    hrd.openSettingsModal();
  });
}

function renderTemplateSection() {
  const box = document.getElementById("hrd-tpl-section");
  if (!box) return;
  const tpl = hrd.state.templates;
  const note = (text) =>
    `<div style="font-size:12px;color:var(--hr-muted);padding:4px 0;">${text}</div>`;
  if (tpl.status === "error") {
    box.innerHTML = note(`模板列表加载失败：${hrd.escapeHtmlText(tpl.error)}`);
    return;
  }
  if (tpl.status !== "ready") {
    box.innerHTML = note("正在加载模板…");
    return;
  }
  const defaultId = hrd.state.ctx.defaultTemplate || "";
  const diagnostics = tpl.diagnostics
    .map(
      (d) =>
        `<div style="font-size:11.5px;color:#a3341a;padding:2px 0;">${hrd.escapeHtmlText(d.source)} 层模板 ${hrd.escapeHtmlText(d.id)} 已跳过 — ${hrd.escapeHtmlText(d.message)}</div>`,
    )
    .join("");
  const rows = tpl.list
    .map((t) => {
      const isDefault = Boolean(defaultId) && t.id === defaultId;
      const meta =
        `${hrd.escapeHtmlText(t.id)} · ${hrd.escapeHtmlText(t.source)}` +
        (t.format ? ` · ${hrd.escapeHtmlText(t.format)}` : "");
      const defaultBtn = isDefault
        ? '<button type="button" class="hrd-btn" data-tpl-clear>清除默认</button>'
        : `<button type="button" class="hrd-btn" data-tpl-default="${hrd.escapeHtmlText(t.id)}">设为默认</button>`;
      const delBtn =
        t.source === "builtin"
          ? ""
          : `<button type="button" class="hrd-btn" data-tpl-delete="${hrd.escapeHtmlText(t.id)}" style="color:#a3341a;">删除</button>`;
      return `
        <div class="hrd-field" style="border-bottom:none;padding:8px 0;">
          <div>
            <div>${hrd.escapeHtmlText(t.name || t.id)}${isDefault ? '<span style="color:var(--hr-muted);font-size:11px;">（默认）</span>' : ""}</div>
            <div style="font-size:11px;color:var(--hr-muted);margin-top:2px;">${meta}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">${defaultBtn}${delBtn}</div>
        </div>`;
    })
    .join("");
  box.innerHTML = diagnostics + (rows || note("还没有可用的模板"));
  [...box.querySelectorAll("[data-tpl-default]")].forEach((btn) =>
    btn.addEventListener("click", () => {
      hrd.bridgeNavigate(
        "/template-set-default?id=" + encodeURIComponent(btn.getAttribute("data-tpl-default")),
      );
    }),
  );
  [...box.querySelectorAll("[data-tpl-clear]")].forEach((btn) =>
    btn.addEventListener("click", () => hrd.bridgeNavigate("/template-clear-default")),
  );
  [...box.querySelectorAll("[data-tpl-delete]")].forEach((btn) =>
    btn.addEventListener("click", () =>
      openDeleteTemplateModal(btn.getAttribute("data-tpl-delete")),
    ),
  );
}

function renderTemplateUi() {
  renderNewDocTemplateFields();
  renderTemplateSection();
}

function openSaveAsTemplateModal() {
  if (hrd.isEmptyMode()) {
    hrd.showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
    return;
  }
  const m = hrd.ensureModal(
    "save-template",
    "存为模板",
    `
      <div class="hrd-field"><span>模板 ID（小写字母、数字与连字符）</span><input type="text" id="hrd-tpl-id" placeholder="例如：weekly-report"/></div>
      <div class="hrd-field"><span>名称（留空用 ID）</span><input type="text" id="hrd-tpl-name" placeholder="例如：周报"/></div>
      <div class="hrd-field"><span>描述</span><input type="text" id="hrd-tpl-desc"/></div>
      <div class="hrd-field" style="border-bottom:none;"><span>保存到全局（所有工作区可用）</span><input type="checkbox" id="hrd-tpl-global"/></div>
    `,
    `
      <button type="button" class="hrd-btn" id="hrd-tpl-cancel">取消</button>
      <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-tpl-ok">保存</button>
    `,
  );
  const idInput = m.querySelector("#hrd-tpl-id");
  idInput.focus();
  const submit = () => {
    const id = idInput.value.trim();
    // Same gate as core's TEMPLATE_ID — refuse before the bridge call exists.
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      hrd.showToast("模板 ID 只能由小写字母、数字与连字符组成，且不超过 64 字符", true);
      return;
    }
    const name = m.querySelector("#hrd-tpl-name").value.trim();
    const desc = m.querySelector("#hrd-tpl-desc").value.trim();
    const isGlobal = m.querySelector("#hrd-tpl-global").checked;
    hrd.closeModal();
    let url =
      "/template-save?doc=" +
      encodeURIComponent(hrd.currentDocId()) +
      "&id=" +
      encodeURIComponent(id);
    if (name) url += "&name=" + encodeURIComponent(name);
    if (desc) url += "&desc=" + encodeURIComponent(desc);
    if (isGlobal) url += "&global=1";
    hrd.bridgeNavigate(url);
  };
  m.querySelector("#hrd-tpl-cancel").addEventListener("click", hrd.closeModal);
  m.querySelector("#hrd-tpl-ok").addEventListener("click", submit);
}

function openNewDocModal() {
  const m = hrd.ensureModal(
    "new-doc",
    "新建排版文档",
    `
      <div class="hrd-field"><span>文档标题</span><input type="text" id="hrd-new-title" placeholder="例如：Q4 产品路线复盘" value="未命名文档"/></div>
      <div class="hrd-field"><span>文件名（自动补 .html）</span><input type="text" id="hrd-new-name" placeholder="例如：q4-review.html"/></div>
      <div class="hrd-field" style="border-bottom:none;"><span>模板</span><select id="hrd-new-template"><option value="">空白文档（默认）</option></select></div>
      <div id="hrd-new-template-hint" style="font-size:11px;color:var(--hr-muted);"></div>
      <div style="font-size:11.5px;color:var(--hr-muted);">将创建在工作区：${hrd.escapeHtmlText(hrd.state.ctx.workspace || "")}</div>
    `,
    `
      <button type="button" class="hrd-btn" id="hrd-new-cancel">取消</button>
      <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-new-ok">创建并打开</button>
    `,
  );
  const titleInput = m.querySelector("#hrd-new-title");
  const nameInput = m.querySelector("#hrd-new-name");
  titleInput.focus();
  titleInput.select();
  const submit = () => {
    const title = titleInput.value.trim() || "未命名文档";
    const file = nameInput.value.trim();
    const templateEl = m.querySelector("#hrd-new-template");
    const template = templateEl ? templateEl.value : "";
    hrd.closeModal();
    let url = "/new?title=" + encodeURIComponent(title) + "&file=" + encodeURIComponent(file);
    if (template) url += "&template=" + encodeURIComponent(template);
    hrd.bridgeNavigate(url);
  };
  const onEnter = (e) => {
    if (e.key === "Enter") submit();
  };
  m.querySelector("#hrd-new-cancel").addEventListener("click", hrd.closeModal);
  m.querySelector("#hrd-new-ok").addEventListener("click", submit);
  nameInput.addEventListener("keydown", onEnter);
  titleInput.addEventListener("keydown", onEnter);
  renderNewDocTemplateFields();
  hrd.requestTemplates();
}

function renderSwitcherList(listEl, files, query, active) {
  const q = query.trim().toLowerCase();
  const matched = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
  const rows = matched
    .map(
      (f) => `
      <button type="button" class="hrd-file-item ${f === active ? "active" : ""}" data-open="${hrd.escapeHtmlText(f)}">
        <span>📄 ${hrd.escapeHtmlText(f)}</span>
        <span style="font-size:11px;color:var(--hr-muted);">${f === active ? "当前" : "打开"}</span>
      </button>
    `,
    )
    .join("");
  listEl.innerHTML =
    rows || '<div style="padding:8px;font-size:12px;color:var(--hr-muted);">没有匹配文件</div>';
}

function openFileSwitcherModal() {
  const files = Array.isArray(hrd.state.ctx.files) ? hrd.state.ctx.files : [];
  const active = hrd.currentDocId();
  const m = hrd.ensureModal(
    "open-doc",
    "快速打开文档",
    `
      <div style="font-size:12px;color:var(--hr-muted);margin-bottom:8px;">当前工作区：${hrd.escapeHtmlText(hrd.state.ctx.workspace || "")}</div>
      <input type="text" id="hrd-open-filter" placeholder="输入文件名过滤…" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--hr-rule);background:var(--hrd-panel-bg);color:var(--hr-ink);margin-bottom:8px;"/>
      <div id="hrd-open-list" style="max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;"></div>
    `,
    `
      <button type="button" class="hrd-btn" id="hrd-open-finder">从访达选取 .html…</button>
      <button type="button" class="hrd-btn" id="hrd-open-folder">切换工作区…</button>
      <button type="button" class="hrd-btn" id="hrd-open-close">关闭</button>
    `,
  );
  const listEl = m.querySelector("#hrd-open-list");
  const filterEl = m.querySelector("#hrd-open-filter");
  const render = () => renderSwitcherList(listEl, files, filterEl.value, active);
  render();
  filterEl.addEventListener("input", render);
  listEl.addEventListener("click", (e) => {
    const item = e.target.closest("[data-open]");
    if (!item) return;
    hrd.closeModal();
    hrd.bridgeNavigate("/open?doc=" + encodeURIComponent(item.getAttribute("data-open")));
  });
  m.querySelector("#hrd-open-finder").addEventListener("click", () => {
    hrd.closeModal();
    hrd.bridgeNavigate("/pick-file");
  });
  m.querySelector("#hrd-open-folder").addEventListener("click", () => {
    hrd.closeModal();
    hrd.bridgeNavigate("/pick-folder");
  });
  m.querySelector("#hrd-open-close").addEventListener("click", hrd.closeModal);
  filterEl.focus();
}

function openComponentModal() {
  if (hrd.isEmptyMode()) {
    hrd.showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
    return;
  }
  const buttons = hrd.COMPONENTS.map(
    (c) => `
      <button type="button" class="hrd-btn" data-comp="${hrd.escapeHtmlText(c.id)}" style="height:auto;padding:10px;justify-content:space-between;">
        <span>${hrd.escapeHtmlText(c.label)}</span>
        <span style="font-size:10px;opacity:0.7;">${hrd.escapeHtmlText(c.tag)}</span>
      </button>
    `,
  ).join("");
  const m = hrd.ensureModal(
    "components",
    "插入结构化排版组件（将在当前选中块后插入）",
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">${buttons}</div>`,
    '<button type="button" class="hrd-btn" id="hrd-comp-close">关闭</button>',
  );
  m.querySelector("#hrd-comp-close").addEventListener("click", hrd.closeModal);
  m.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-comp]");
    if (!btn) return;
    const comp = hrd.COMPONENTS.find((c) => c.id === btn.getAttribute("data-comp"));
    hrd.closeModal();
    if (comp) hrd.insertAfterBlock(hrd.activeBlockEl(), comp.html, comp.label, false);
  });
}

function openHelpModal() {
  const m = hrd.ensureModal(
    "help",
    "hReader 桌面工作台 · Typora 快捷键与功能指南",
    `
      <div class="hrd-field"><span>点击任意段落原地输入（Enter 新段、Backspace 删空段）</span><code>所见即所得</code></div>
      <div class="hrd-field"><span>段首 Markdown 快捷语法</span><code># / ## / ### / &gt;</code></div>
      <div class="hrd-field"><span>立即保存当前文档编辑</span><code>⌘S</code></div>
      <div class="hrd-field"><span>显隐左侧边栏 / 显隐右侧批注抽屉</span><code>⌘⇧L / ⌘⇧R</code></div>
      <div class="hrd-field"><span>切换 HTML 源码模式 / 专注模式</span><code>⌘/ / ⌘⇧F</code></div>
      <div class="hrd-field"><span>插入组件 / 编辑块完整 HTML</span><code>⌘⇧K / ⌘E</code></div>
      <div class="hrd-field"><span>快速切换文档 / 新建文档 / 偏好设置</span><code>⌘O / ⌘N / ⌘,</code></div>
      <div class="hrd-field"><span>沉浸模式（隐藏外壳）/ 原生全屏</span><code>⌘⇧I 或 i · Esc / ^⌘F</code></div>
      <div class="hrd-field" style="border-bottom:none;"><span>过滤大纲 / 整段批注 / 改动 Diff</span><code>/ · c · Shift+D</code></div>
    `,
    `
      <button type="button" class="hrd-btn" id="hrd-help-welcome">打开欢迎指南文档</button>
      <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-help-ok">知道了</button>
    `,
  );
  m.querySelector("#hrd-help-welcome").addEventListener("click", () => {
    hrd.closeModal();
    hrd.bridgeNavigate("/welcome");
  });
  m.querySelector("#hrd-help-ok").addEventListener("click", hrd.closeModal);
}

Object.assign(hrd, {
  openSettingsModal,
  openNewDocModal,
  openFileSwitcherModal,
  openComponentModal,
  openHelpModal,
  openSaveAsTemplateModal,
  renderTemplateUi,
});
