// 样式注入、内置与自定义主题应用，以及默认阅读器主题兜底加载。
const hrd = window.__hrd;

function injectStyles() {
  if (document.getElementById("hr-desktop-styles")) return;
  const style = document.createElement("style");
  style.id = "hr-desktop-styles";
  style.textContent = hrd.css;
  document.head.appendChild(style);
}

function buildCustomVarsCss(varsObj) {
  if (!varsObj || typeof varsObj !== "object") return "";
  const lines = Object.entries(varsObj)
    .filter(([k, v]) => typeof k === "string" && k.startsWith("--") && typeof v === "string")
    .map(([k, v]) => "  " + k + ": " + v + ";");
  return lines.length ? ":root, body {\n" + lines.join("\n") + "\n}\n" : "";
}

function applyCustomThemeStyle(themeObj) {
  let styleEl = document.getElementById("hr-desktop-custom-theme");
  if (!themeObj) {
    if (styleEl) styleEl.textContent = "";
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "hr-desktop-custom-theme";
    document.head.appendChild(styleEl);
  }
  const extraCss = typeof themeObj.css === "string" ? themeObj.css : "";
  styleEl.textContent = buildCustomVarsCss(themeObj.vars) + extraCss;
}

function resolveTheme(selected) {
  if (selected === "light" || selected === "paper" || selected === "dark") {
    return { base: selected, custom: null };
  }
  const custom = hrd.customThemesList().find((t) => t.id === selected) || null;
  if (!custom) {
    hrd.state.prefs = { ...hrd.state.prefs, uiTheme: "light" };
    return { base: "light", custom: null };
  }
  const base = custom.base === "paper" || custom.base === "dark" ? custom.base : "light";
  return { base, custom };
}

function applyPrefs() {
  const { prefs, ctx } = hrd.state;
  const { base, custom } = resolveTheme(String(prefs.uiTheme || "light"));
  applyCustomThemeStyle(custom);
  document.body.setAttribute("data-hrd-os", ctx.isMacos ? "macos" : "other");
  document.body.setAttribute("data-hrd-bar", prefs.bottomBarStyle === "bar" ? "bar" : "floating");
  document.body.setAttribute("data-hrd-theme", base);
  document.documentElement.setAttribute("data-hr-mode", base === "dark" ? "dark" : "light");
  document.body.setAttribute("data-hrd-ids", prefs.showBlockIds ? "true" : "false");
  document.body.setAttribute("data-hrd-focus", prefs.focusMode ? "true" : "false");
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--hrd-font-size", String(prefs.fontSize) + "px");
  rootStyle.setProperty("--hrd-line-height", String(prefs.lineHeight));
  rootStyle.setProperty("--hrd-doc-width", prefs.maxWidth);
  const focusBtn = document.getElementById("hrd-sb-focus");
  if (focusBtn) focusBtn.classList.toggle("active", Boolean(prefs.focusMode));
}

function ensureDefaultThemeLoaded() {
  if (hrd.state.themeHydrated || hrd.isEmptyMode()) return;
  const styleEl = document.getElementById("hr-theme");
  if (!styleEl || (styleEl.textContent || "").trim() !== "") return;
  hrd.state.themeHydrated = true;
  const visual = hrd.state.prefs.defaultVisual || "atelier-editorial";
  fetch("/api/theme/" + encodeURIComponent(visual), { credentials: "same-origin" })
    .then((res) => (res.ok ? res.text() : ""))
    .then((css) => {
      if (css && (styleEl.textContent || "").trim() === "") {
        styleEl.textContent = css;
      }
    })
    .catch(() => {
      hrd.state.themeHydrated = false;
    });
}

function buildUiThemeOptionsHtml() {
  const { escapeHtmlText } = hrd;
  const current = hrd.state.prefs.uiTheme;
  const customs = hrd.customThemesList();
  const customOpts = customs.length
    ? customs
        .map(
          (t) =>
            `<option value="${escapeHtmlText(t.id)}" ${current === t.id ? "selected" : ""}>${escapeHtmlText(t.name)}</option>`,
        )
        .join("")
    : '<option value="" disabled>暂无配置（点击下方打开目录）</option>';
  return `
    <optgroup label="内置外观">
      <option value="light" ${current === "light" ? "selected" : ""}>纯净原生白（默认）</option>
      <option value="paper" ${current === "paper" ? "selected" : ""}>暖纸典藏（Paper）</option>
      <option value="dark" ${current === "dark" ? "selected" : ""}>深色静谧（Dark）</option>
    </optgroup>
    <optgroup label="自定义主题 (~/.hreader/themes)">
      ${customOpts}
    </optgroup>
  `;
}

Object.assign(hrd, {
  injectStyles,
  applyPrefs,
  ensureDefaultThemeLoaded,
  buildUiThemeOptionsHtml,
});
