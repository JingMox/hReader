//! 桌面阅读与笔记工作台：欢迎文档、新文档模板、Obsidian 式嵌套文件树、自定义主题加载，
//! 以及注入 Webview 的 Typora 排版编辑器与偏好设置脚本。
//! 本模块保持纯 Rust（不碰 `tauri`），遵守桌面壳静态层分界（`check.sh`）。

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

const MAX_TREE_DEPTH: usize = 8;
const MAX_TREE_NODES: usize = 2000;

/// 左侧文件树节点类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeEntryKind {
    Dir,
    File,
}

/// 左侧工作区目录树节点（支持任意层级嵌套文件夹与 HTML 笔记）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: TreeEntryKind,
    pub children: Vec<TreeNode>,
}

/// 用户自定义外观主题（从 `~/.hreader/themes/*.json` 或 `<workspace>/.hreader/themes/*.json` 加载）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub base: String,
    pub vars: Vec<(String, String)>,
    pub css: String,
}

/// 注入前端的工作台上下文（通过 `initialization_script` 与 `on_page_load` 同步到 `window.__HR_DESKTOP_CTX__`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkbenchContext {
    pub workspace: String,
    pub doc_id: String,
    pub files: Vec<String>,
    pub tree: Vec<TreeNode>,
    pub custom_themes: Vec<CustomTheme>,
    pub is_macos: bool,
}

/// 生成供 HTML 标签或正文中使用的转义文本。
pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn should_skip_entry_name(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist")
}

/// 递归扫描工作区，返回按「文件夹优先 + 字母序」排列的嵌套目录树（仅包含目录与 `.html`/`.htm` 文件）。
pub fn scan_workspace_tree(workspace: &Path) -> Vec<TreeNode> {
    let mut remaining = MAX_TREE_NODES;
    scan_dir_nodes(workspace, "", 0, &mut remaining)
}

fn scan_dir_nodes(dir: &Path, prefix: &str, depth: usize, remaining: &mut usize) -> Vec<TreeNode> {
    if depth >= MAX_TREE_DEPTH || *remaining == 0 {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut nodes = Vec::new();
    for entry in entries.flatten() {
        if *remaining == 0 {
            break;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if should_skip_entry_name(&name) {
            continue;
        }
        let path = entry.path();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            *remaining = remaining.saturating_sub(1);
            let children = scan_dir_nodes(&path, &rel, depth + 1, remaining);
            nodes.push(TreeNode {
                name,
                path: rel,
                kind: TreeEntryKind::Dir,
                children,
            });
        } else if path.is_file() && is_html_file(&path) {
            *remaining = remaining.saturating_sub(1);
            nodes.push(TreeNode {
                name,
                path: rel,
                kind: TreeEntryKind::File,
                children: Vec::new(),
            });
        }
    }
    nodes.sort_by(compare_tree_nodes);
    nodes
}

fn compare_tree_nodes(a: &TreeNode, b: &TreeNode) -> Ordering {
    let rank = |k: TreeEntryKind| match k {
        TreeEntryKind::Dir => 0u8,
        TreeEntryKind::File => 1u8,
    };
    rank(a.kind)
        .cmp(&rank(b.kind))
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

fn collect_files_from_tree(nodes: &[TreeNode], out: &mut Vec<String>) {
    for node in nodes {
        match node.kind {
            TreeEntryKind::Dir => collect_files_from_tree(&node.children, out),
            TreeEntryKind::File => out.push(node.path.clone()),
        }
    }
}

/// 枚举工作区内所有嵌套子目录下的 `.html`/`.htm` 文档相对路径（排序返回）。
pub fn list_html_files(workspace: &Path) -> Vec<String> {
    let tree = scan_workspace_tree(workspace);
    let mut files = Vec::new();
    collect_files_from_tree(&tree, &mut files);
    files.sort();
    files
}

pub fn is_html_file(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
    })
}

/// 返回用户级自定义主题配置目录（`~/.hreader/themes`）。
pub fn user_themes_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    Some(home.join(".hreader").join("themes"))
}

const SAMPLE_CUSTOM_THEME: &str = r##"{
  "id": "nord-slate",
  "name": "Nord Slate (自定义示例)",
  "base": "dark",
  "vars": {
    "--hr-paper": "#1d222b",
    "--hr-bg": "#1d222b",
    "--hr-fg": "#e5e9f0",
    "--hr-ink": "#eceff4",
    "--hr-accent": "#88c0d0",
    "--hr-rule": "#2e3440",
    "--hr-border": "#2e3440",
    "--hrd-panel-bg": "#171b22",
    "--hrd-sb-bg": "rgba(23, 27, 34, 0.92)",
    "--hrd-guide": "#323946",
    "--hrd-card-bg": "#242933"
  },
  "css": ""
}
"##;

/// 确保主题目录存在；若尚无任何 `.json` 主题文件，写入一份可直接修改的示例配置文件。
pub fn ensure_user_themes_dir_in(dir: &Path) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let has_json = fs::read_dir(dir).ok().is_some_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        })
    });
    if !has_json {
        fs::write(dir.join("nord-example.json"), SAMPLE_CUSTOM_THEME)?;
    }
    Ok(dir.to_path_buf())
}

/// 从用户全局目录与工作区 `.hreader/themes/*.json` 加载已校验的安全自定义主题。
pub fn load_custom_themes(user_dir: Option<&Path>, workspace: &Path) -> Vec<CustomTheme> {
    let mut themes: Vec<CustomTheme> = Vec::new();
    if let Some(dir) = user_dir {
        read_themes_from_dir(dir, &mut themes);
    }
    let ws_themes = workspace.join(".hreader").join("themes");
    read_themes_from_dir(&ws_themes, &mut themes);
    themes
}

fn read_themes_from_dir(dir: &Path, out: &mut Vec<CustomTheme>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        })
        .collect();
    paths.sort();
    for path in paths {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("custom");
        let Some(theme) = parse_custom_theme_json(&raw, stem) else {
            continue;
        };
        if let Some(slot) = out.iter_mut().find(|existing| existing.id == theme.id) {
            *slot = theme;
        } else {
            out.push(theme);
        }
    }
}

fn parse_custom_theme_json(raw: &str, fallback_stem: &str) -> Option<CustomTheme> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let obj = value.as_object()?;
    let raw_id = obj
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(fallback_stem);
    let id = sanitize_theme_id(raw_id, fallback_stem);
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&id)
        .chars()
        .take(64)
        .collect::<String>();
    let base = sanitize_theme_base(obj.get("base").and_then(Value::as_str));

    let mut vars = Vec::new();
    if let Some(map) = obj.get("vars").and_then(Value::as_object) {
        for (k, v) in map {
            if let Some(val_str) = v.as_str() {
                let val_trimmed = val_str.trim();
                if is_safe_css_var_name(k) && is_safe_css_var_value(val_trimmed) {
                    vars.push((k.clone(), val_trimmed.to_string()));
                }
            }
        }
    }

    let css = obj
        .get("css")
        .and_then(Value::as_str)
        .map(sanitize_custom_css)
        .unwrap_or_default();

    Some(CustomTheme {
        id,
        name,
        base,
        vars,
        css,
    })
}

fn sanitize_theme_id(raw: &str, fallback: &str) -> String {
    let filter = |input: &str| -> String {
        input
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(48)
            .collect()
    };
    let mut id = filter(raw);
    if id.is_empty() {
        id = filter(fallback);
    }
    if id.is_empty() {
        id = "custom-theme".to_string();
    }
    if matches!(id.as_str(), "light" | "paper" | "dark") {
        format!("custom-{id}")
    } else {
        id
    }
}

fn sanitize_theme_base(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some("paper") => "paper".to_string(),
        Some("dark") => "dark".to_string(),
        _ => "light".to_string(),
    }
}

fn is_safe_css_var_name(name: &str) -> bool {
    name.starts_with("--")
        && name.len() >= 3
        && name.len() <= 64
        && name[2..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn is_safe_css_var_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains([';', '{', '}', '<', '\n', '\r'])
}

fn sanitize_custom_css(raw: &str) -> String {
    let mut out = raw.to_string();
    loop {
        let lower = out.to_ascii_lowercase();
        let Some(pos) = lower.find("</style") else {
            break;
        };
        out.replace_range(pos..pos + 7, "");
    }
    out.chars().take(16_384).collect()
}

/// 新建空白排版文档模板（已带规范 `data-hr-id`，可立即在阅读器和 CLI 中使用）。
pub fn starter_html(title: &str) -> String {
    let safe_title = escape_html(if title.trim().is_empty() {
        "未命名文档"
    } else {
        title.trim()
    });
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>{safe_title}</title>
</head>
<body>
<article data-hr-id="doc-root">
  <h1 data-hr-id="s0-h1">{safe_title}</h1>
  <p data-hr-id="s0-p1">直接点击任意段落即可像 Typora 一样原地编辑，按 Enter 新建段落，输入 # 或 ## 可快速切换标题。</p>
  <h2 data-hr-id="s1-h2">一、核心结论</h2>
  <p data-hr-id="s1-p1">先写结论，再用证据与结构化组件展开说明。</p>
  <div data-hr-id="s1-callout" data-hr-component="callout-insight">
    <p>提示：划词可选中句子添加侧边批注，每次修改都会保存快照，可随时撤销。</p>
  </div>
</article>
</body>
</html>
"#
    )
}

/// 首次无工作区文档打开时的欢迎引导页（带 7 种核心能力与真实组件演示）。
pub fn welcome_html() -> &'static str {
    r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>欢迎使用 hReader 桌面工作台</title>
</head>
<body>
<article data-hr-id="doc-root">
  <h1 data-hr-id="w0-h1">欢迎使用 hReader 桌面阅读与排版工作台</h1>
  <p data-hr-id="w0-p1">hReader 以单文件 HTML 为原生载体，融合左侧大纲与文件树、沉浸式居中画布、所见即所得行内编辑、7 种结构化组件与出版级导出。</p>
  <div data-hr-id="w0-kpi" data-hr-component="kpi-bento">
    <div>
      <p><strong>直接输入</strong></p>
      <p>像 Typora 一样点击即写，Enter 新建段</p>
    </div>
    <div>
      <p><strong>7 种组件</strong></p>
      <p>KPI、Callout、对比栏、折叠、时间线、图表</p>
    </div>
    <div>
      <p><strong>一键出版</strong></p>
      <p>导出带书签 A4 PDF、高清长图或打印稿</p>
    </div>
  </div>
  <h2 data-hr-id="w1-h2">一、像 Typora 一样自然写作</h2>
  <p data-hr-id="w1-p1">左侧边栏可在「大纲」和「文件」间切换，底部状态栏可随时切换侧栏、源码视图（Cmd+/）、批注抽屉与字数统计。</p>
  <p data-hr-id="w1-p2">点击任意普通段落即可原地编辑，输入 ## 加空格可快速转为二级标题；按 Cmd+O 快速切换文档，按 Cmd+N 新建长文。</p>
  <div data-hr-id="w1-insight" data-hr-component="callout-insight">
    <p>每一处修改都会自动进入历史快照链。觉得改坏了？在「编辑」菜单或按 Cmd+Shift+Z 即可撤销文档快照。</p>
  </div>
  <h2 data-hr-id="w2-h2">二、划词批注与历史 Diff</h2>
  <p data-hr-id="w2-p1">在正文中划选一句话，旁边会出现「批注选区」气泡；或选中段落按 c 键快速批注，按 Shift+D 查看修订前后的 Diff 对比。</p>
</article>
</body>
</html>
"#
}

fn tree_to_json(nodes: &[TreeNode]) -> Value {
    Value::Array(
        nodes
            .iter()
            .map(|node| {
                let kind = match node.kind {
                    TreeEntryKind::Dir => "dir",
                    TreeEntryKind::File => "file",
                };
                json!({
                    "name": node.name,
                    "path": node.path,
                    "kind": kind,
                    "children": tree_to_json(&node.children),
                })
            })
            .collect(),
    )
}

fn custom_themes_to_json(themes: &[CustomTheme]) -> Value {
    Value::Array(
        themes
            .iter()
            .map(|theme| {
                let mut vars_map = Map::new();
                for (k, v) in &theme.vars {
                    vars_map.insert(k.clone(), Value::String(v.clone()));
                }
                json!({
                    "id": theme.id,
                    "name": theme.name,
                    "base": theme.base,
                    "vars": Value::Object(vars_map),
                    "css": theme.css,
                })
            })
            .collect(),
    )
}

fn context_json(ctx: &WorkbenchContext) -> Value {
    json!({
        "workspace": ctx.workspace,
        "docId": ctx.doc_id,
        "files": ctx.files,
        "tree": tree_to_json(&ctx.tree),
        "customThemes": custom_themes_to_json(&ctx.custom_themes),
        "isMacos": ctx.is_macos,
    })
}

/// 序列化实时工作台上下文，用于在 `on_page_load` 时刷新前端文档与工作区状态。
pub fn sync_payload_js(ctx: &WorkbenchContext) -> String {
    let payload = context_json(ctx);
    format!("window.__hrDesktopSync && window.__hrDesktopSync({payload});")
}

/// 生成注入到 Webview 窗口的完整初始化脚本。
pub fn init_script(ctx: &WorkbenchContext) -> String {
    let payload = context_json(ctx);
    format!("window.__HR_DESKTOP_CTX__ = {payload};\n{WORKBENCH_JS}")
}

const WORKBENCH_JS: &str = r##"
(() => {
  if (window.__HR_DESKTOP_INSTALLED__) return;
  window.__HR_DESKTOP_INSTALLED__ = true;

  const PREFS_KEY = "hr_desktop_prefs_v3";
  const DEFAULT_PREFS = {
    uiTheme: "light",
    bottomBarStyle: "floating",
    fontSize: 17,
    lineHeight: 1.75,
    maxWidth: "740px",
    showBlockIds: false,
    focusMode: false,
    defaultVisual: "atelier-editorial"
  };

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem(PREFS_KEY);
      if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
      const legacy = window.localStorage.getItem("hr_desktop_prefs_v2");
      if (legacy) {
        const old = JSON.parse(legacy);
        return {
          ...DEFAULT_PREFS,
          fontSize: old.fontSize || DEFAULT_PREFS.fontSize,
          lineHeight: old.lineHeight || DEFAULT_PREFS.lineHeight,
          maxWidth: old.maxWidth || DEFAULT_PREFS.maxWidth,
          showBlockIds: Boolean(old.showBlockIds),
          focusMode: Boolean(old.focusMode),
          defaultVisual: old.defaultVisual || DEFAULT_PREFS.defaultVisual
        };
      }
      return { ...DEFAULT_PREFS };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs(next) {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {}
    return next;
  }

  let prefs = loadPrefs();
  let ctx = window.__HR_DESKTOP_CTX__ || { workspace: "", docId: "", files: [], tree: [], customThemes: [], isMacos: false };
  let activeSidebarTab = "files";
  try {
    const savedTab = window.sessionStorage.getItem("hrd_sidebar_tab");
    if (savedTab === "toc" || savedTab === "files") activeSidebarTab = savedTab;
  } catch {}
  let searchOpen = false;
  let sourceMode = false;
  let notesOpen = false;
  let activeEditId = null;
  let editDirty = false;
  let lastInputAt = 0;
  let saveTimer = null;
  let saveInFlight = Promise.resolve();
  let gutterBlock = null;
  let gutterTimer = null;
  let openMenuKind = null;
  let sbHideTimer = null;

  function currentDocId() {
    const q = new URLSearchParams(window.location.search).get("doc");
    if (q) return q;
    if (window.location.pathname.startsWith("/s/")) {
      return decodeURIComponent(window.location.pathname.slice(3));
    }
    return ctx.docId || "";
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

  function isSimpleEditableBlock(el) {
    if (!(el instanceof Element)) return false;
    if (!el.hasAttribute("data-hr-id") || el.hasAttribute("data-hr-component")) return false;
    if (el.closest("[data-hr-component]")) return false;
    const tag = el.tagName.toLowerCase();
    return tag === "p" || tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "blockquote";
  }

  function supportsPlaintextEditable() {
    try {
      const probe = document.createElement("div");
      probe.setAttribute("contenteditable", "plaintext-only");
      return probe.contentEditable === "plaintext-only";
    } catch {
      return false;
    }
  }
  const EDITABLE_VALUE = supportsPlaintextEditable() ? "plaintext-only" : "true";

  function injectStyles() {
    if (document.getElementById("hr-desktop-styles")) return;
    const style = document.createElement("style");
    style.id = "hr-desktop-styles";
    style.textContent = `
      :root,
      body[data-hrd-theme="light"] {
        --hrd-side-w: 264px;
        --hrd-notes-w: 300px;
        --hr-bg: #ffffff;
        --hr-fg: #1d1d1f;
        --hr-paper: #ffffff;
        --hr-ink: #111113;
        --hr-rule: #e5e5ea;
        --hr-border: #e5e5ea;
        --hr-muted: #6e6e73;
        --hr-accent: #2563eb;
        --hr-code-bg: #f3f4f6;
        --hrd-panel-bg: #f6f6f7;
        --hrd-sb-bg: rgba(249, 249, 251, 0.90);
        --hrd-sb-border: rgba(0, 0, 0, 0.09);
        --hrd-guide: #e1e1e6;
        --hrd-hover: rgba(0, 0, 0, 0.045);
        --hrd-active-soft: #e6e6eb;
        --hrd-active-block: rgba(37, 99, 235, 0.04);
        --hrd-card-bg: #ffffff;
        --hrd-doc-width: 740px;
        --hrd-font-size: 17px;
        --hrd-line-height: 1.75;
      }
      body[data-hrd-theme="paper"] {
        --hr-bg: #faf8f4;
        --hr-fg: #1f1d1a;
        --hr-paper: #faf8f4;
        --hr-ink: #1b1a17;
        --hr-rule: #e3dbd0;
        --hr-border: #e3dbd0;
        --hr-muted: #766e63;
        --hr-accent: #8a4a22;
        --hr-code-bg: #f1ece2;
        --hrd-panel-bg: #f2ede4;
        --hrd-sb-bg: rgba(246, 242, 234, 0.92);
        --hrd-sb-border: rgba(90, 70, 50, 0.14);
        --hrd-guide: #dcd3c4;
        --hrd-hover: rgba(122, 75, 31, 0.065);
        --hrd-active-soft: rgba(138, 74, 34, 0.13);
        --hrd-active-block: rgba(138, 74, 34, 0.045);
        --hrd-card-bg: #ffffff;
      }
      body[data-hrd-theme="dark"] {
        --hr-bg: #141518;
        --hr-fg: #e4e4e7;
        --hr-paper: #141518;
        --hr-ink: #f4f4f5;
        --hr-rule: #272a32;
        --hr-border: #272a32;
        --hr-muted: #8e929b;
        --hr-accent: #e0a97a;
        --hr-code-bg: #22252c;
        --hrd-panel-bg: #1b1d22;
        --hrd-sb-bg: rgba(27, 29, 34, 0.90);
        --hrd-sb-border: rgba(255, 255, 255, 0.10);
        --hrd-guide: #2c303a;
        --hrd-hover: rgba(255, 255, 255, 0.055);
        --hrd-active-soft: rgba(255, 255, 255, 0.095);
        --hrd-active-block: rgba(224, 169, 122, 0.07);
        --hrd-card-bg: #1f222a;
      }
      html, body {
        height: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: var(--hr-paper) !important;
        color: var(--hr-ink) !important;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif !important;
      }
      #hr-root {
        display: grid !important;
        grid-template-columns: var(--hrd-side-w) minmax(0, 1fr) 0px !important;
        grid-template-rows: minmax(0, 1fr) !important;
        width: 100vw !important;
        height: 100vh !important;
        max-height: 100vh !important;
        min-height: 0 !important;
        padding: 0 !important;
        gap: 0 !important;
        overflow: hidden !important;
        background: var(--hr-paper) !important;
      }
      #hr-root.hrd-notes-open {
        grid-template-columns: var(--hrd-side-w) minmax(0, 1fr) var(--hrd-notes-w) !important;
      }
      #hr-root.hrd-hide-left {
        grid-template-columns: 0px minmax(0, 1fr) 0px !important;
      }
      #hr-root.hrd-hide-left.hrd-notes-open {
        grid-template-columns: 0px minmax(0, 1fr) var(--hrd-notes-w) !important;
      }
      #hr-library, #hr-canvas, #hr-notes {
        grid-row: 1 !important;
        min-height: 0 !important;
        height: 100% !important;
        max-height: 100% !important;
        overscroll-behavior: contain;
        box-sizing: border-box !important;
        margin: 0 !important;
      }
      #hr-library {
        grid-column: 1 !important;
        display: flex !important;
        flex-direction: column;
        gap: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: var(--hrd-panel-bg);
        border-right: 1px solid var(--hr-rule);
        user-select: none;
        font-size: 13px;
      }
      #hr-root.hrd-hide-left #hr-library {
        padding: 0 !important;
        border-right: none !important;
        opacity: 0;
        pointer-events: none;
      }
      #hr-lib-title, #hr-toc-title, #hr-search-label, #hr-controls {
        display: none !important;
      }
      .hrd-traffic-spacer {
        display: none;
        height: 36px;
        flex-shrink: 0;
      }
      body[data-hrd-os="macos"] .hrd-traffic-spacer {
        display: block;
      }
      .hrd-side-head {
        height: 34px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 0 10px;
        border-bottom: 1px solid var(--hr-rule);
      }
      .hrd-vault-btn {
        background: transparent;
        border: none;
        padding: 3px 6px;
        border-radius: 6px;
        color: var(--hr-ink);
        font-size: 12px;
        font-weight: 600;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        max-width: 168px;
        cursor: pointer;
      }
      .hrd-vault-btn:hover { background: var(--hrd-hover); }
      .hrd-vault-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .hrd-sb-heading {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: var(--hr-muted);
      }
      .hrd-side-actions {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
      }
      .hrd-icon-btn {
        background: transparent;
        border: none;
        color: var(--hr-muted);
        border-radius: 6px;
        width: 26px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 13px;
        padding: 0;
      }
      .hrd-icon-btn:hover { background: var(--hrd-hover); color: var(--hr-ink); }
      .hrd-icon-btn.active { background: var(--hrd-active-soft); color: var(--hr-ink); }
      #hr-search {
        display: none;
        width: calc(100% - 16px);
        margin: 8px 8px 2px;
        box-sizing: border-box;
        padding: 5px 9px;
        border-radius: 6px;
        border: 1px solid var(--hr-rule);
        background: var(--hrd-card-bg);
        color: var(--hr-ink);
        font-size: 12px;
        outline: none;
        flex-shrink: 0;
      }
      #hr-search.open { display: block; }
      #hr-search:focus { border-color: var(--hr-accent); }
      #hr-toc {
        list-style: none;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 8px 8px 28px !important;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      #hr-toc.hidden { display: none !important; }
      .toc__item {
        padding: 5px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12.5px;
        line-height: 1.44;
        color: var(--hr-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .toc__item:hover { background: var(--hrd-hover); color: var(--hr-ink); }
      .toc__item--on {
        background: var(--hrd-active-soft) !important;
        color: var(--hr-ink) !important;
        font-weight: 600;
      }
      .toc__item--h1 { font-weight: 600; color: var(--hr-ink); }
      .toc__item--h2 { padding-left: 18px; }
      .toc__item--h3 { padding-left: 30px; font-size: 12px; }
      #hr-files-panel {
        display: none;
        flex: 1;
        min-height: 0;
        flex-direction: column;
      }
      #hr-files-panel.active { display: flex; }
      .hrd-tree-scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 8px 8px 16px 6px;
      }
      .hrd-tree-row {
        width: 100%;
        box-sizing: border-box;
        height: 26px;
        padding: 0 8px 0 4px;
        border-radius: 6px;
        border: none;
        background: transparent;
        color: var(--hr-fg);
        font-size: 12.5px;
        text-align: left;
        display: flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
      }
      .hrd-tree-row:hover { background: var(--hrd-hover); }
      .hrd-tree-row.file {
        padding-left: 18px;
        justify-content: space-between;
      }
      .hrd-tree-row.file.active {
        background: var(--hrd-active-soft);
        color: var(--hr-ink);
        font-weight: 600;
      }
      .hrd-tree-chev {
        width: 14px;
        height: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--hr-muted);
        flex-shrink: 0;
      }
      .hrd-tree-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
      }
      .hrd-tree-tag {
        font-size: 9.5px;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: var(--hr-muted);
        opacity: 0.8;
        flex-shrink: 0;
        margin-left: 6px;
      }
      .hrd-tree-children {
        margin-left: 10px;
        padding-left: 8px;
        border-left: 1px solid var(--hrd-guide);
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .hrd-tree-children.collapsed { display: none; }
      .hrd-vault-foot {
        flex-shrink: 0;
        padding: 8px 12px 10px;
        border-top: 1px solid var(--hr-rule);
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: var(--hr-muted);
      }
      .hrd-vault-new {
        background: transparent;
        border: none;
        padding: 2px 6px;
        border-radius: 5px;
        font-size: 11px;
        color: var(--hr-ink);
        cursor: pointer;
      }
      .hrd-vault-new:hover { background: var(--hrd-hover); }
      .hrd-sb-doc-badge {
        margin: auto 10px 10px;
        padding: 8px 10px;
        background: var(--hrd-hover);
        border-radius: 7px;
        font-size: 11px;
        color: var(--hr-muted);
        line-height: 1.45;
        word-break: break-all;
      }
      .hrd-sb-doc-badge b {
        color: var(--hr-ink);
        display: block;
        margin-bottom: 2px;
      }
      #hr-canvas {
        grid-column: 2 !important;
        min-width: 0;
        overflow-y: auto !important;
        padding: 0 56px 140px !important;
        position: relative;
        background: var(--hr-paper);
      }
      #hrd-overlay-title {
        position: sticky;
        top: 0;
        z-index: 40;
        height: 36px;
        margin: 0 -56px 12px;
        padding: 0 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 500;
        color: var(--hr-muted);
        background: var(--hr-paper);
        background: color-mix(in srgb, var(--hr-paper) 90%, transparent);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        user-select: none;
      }
      body[data-hrd-os="macos"] #hr-root.hrd-hide-left #hrd-overlay-title {
        padding-left: 84px;
      }
      #hrd-overlay-title .hrd-crumb-name {
        color: var(--hr-ink);
        font-weight: 500;
      }
      #hr-doc {
        max-width: var(--hrd-doc-width) !important;
        margin: 0 auto !important;
        font-family: "Iowan Old Style", "Songti SC", "PingFang SC", Georgia, serif;
        font-size: var(--hrd-font-size) !important;
        line-height: var(--hrd-line-height) !important;
        color: var(--hr-ink);
        position: relative;
      }
      #hr-doc [data-hr-id]:not(article) {
        position: relative;
        border-radius: 4px;
        outline: none;
        transition: opacity 160ms ease, border-color 120ms ease;
      }
      #hr-doc [data-hr-id]:not(article):not([data-hr-component]) {
        border-left: 2px solid transparent !important;
        padding: 3px 10px !important;
        margin-top: 2px;
        margin-bottom: 6px;
      }
      #hr-doc [data-hr-id]:not(article):not([data-hr-component]):hover {
        background: var(--hrd-hover);
      }
      #hr-doc [data-hr-id][data-hr-component]:hover {
        box-shadow: 0 0 0 1px var(--hr-border);
      }
      #hr-doc .doc__block--on:not([data-hr-component]) {
        background: var(--hrd-active-block) !important;
        border-left-color: var(--hr-accent) !important;
      }
      #hr-doc .doc__block--on[data-hr-component] {
        box-shadow: 0 0 0 1.5px var(--hr-accent);
      }
      #hr-doc [data-hr-id][contenteditable] {
        min-height: 1.6em;
      }
      #hr-doc [data-hr-id][contenteditable]:focus {
        background: transparent !important;
        border-left-color: var(--hr-accent) !important;
      }
      #hr-doc [data-hr-id][contenteditable]:focus:empty::before {
        content: "输入正文…（支持 # 标题、> 引用、Enter 换行）";
        color: var(--hr-muted);
        opacity: 0.45;
        pointer-events: none;
      }
      #hr-doc .hr-note-target {
        outline: 1.5px solid var(--hr-accent) !important;
        outline-offset: 2px;
        background: var(--hrd-active-soft) !important;
      }
      body[data-hrd-theme="dark"] #hr-doc .hr-flash {
        background: rgba(217, 155, 82, 0.28) !important;
      }
      body[data-hrd-theme="dark"] #hr-doc .doc__block--on:not([data-hr-component]) {
        background: var(--hrd-active-block) !important;
      }
      body[data-hrd-focus="true"] #hr-doc [data-hr-id]:not(article):not(.doc__block--on):not(:focus-within) {
        opacity: 0.34;
      }
      body[data-hrd-ids="true"] #hr-doc [data-hr-id]:not(article)::before {
        content: attr(data-hr-id);
        position: absolute;
        left: -74px;
        top: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10px;
        color: var(--hr-muted);
        opacity: 0.65;
        pointer-events: none;
      }
      #hrd-block-gutter {
        position: absolute;
        display: none;
        align-items: center;
        gap: 2px;
        z-index: 60;
        user-select: none;
      }
      #hrd-block-gutter.visible { display: flex; }
      .hrd-gut-btn {
        width: 22px;
        height: 22px;
        border-radius: 5px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--hr-muted);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      .hrd-gut-btn:hover {
        background: var(--hrd-panel-bg);
        border-color: var(--hr-rule);
        color: var(--hr-ink);
      }
      #hrd-float-menu {
        position: fixed;
        min-width: 196px;
        max-height: 70vh;
        overflow-y: auto;
        background: var(--hrd-card-bg);
        color: var(--hr-ink);
        border: 1px solid var(--hr-rule);
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16);
        padding: 4px;
        z-index: 950;
        display: none;
      }
      #hrd-float-menu.open { display: block; }
      .hrd-menu-hdr {
        font-size: 11px;
        color: var(--hr-muted);
        padding: 4px 8px;
        font-weight: 600;
      }
      .hrd-dd-item {
        width: 100%;
        text-align: left;
        background: transparent;
        border: none;
        color: var(--hr-ink);
        padding: 6px 9px;
        border-radius: 5px;
        font-size: 12.5px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }
      .hrd-dd-item:hover { background: var(--hrd-hover); }
      .hrd-dd-sep { height: 1px; background: var(--hr-rule); margin: 4px 6px; }
      #hrd-sel-pop {
        position: fixed;
        display: none;
        z-index: 920;
        background: var(--hrd-card-bg);
        border: 1px solid var(--hr-rule);
        border-radius: 999px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
        padding: 3px 10px;
        font-size: 12px;
        color: var(--hr-ink);
        cursor: pointer;
      }
      #hrd-sel-pop.open { display: inline-flex; align-items: center; gap: 5px; }
      #hrd-sel-pop:hover { background: var(--hrd-active-soft); border-color: var(--hr-accent); }
      #hrd-source-pane {
        display: none;
        max-width: var(--hrd-doc-width);
        margin: 0 auto;
        flex-direction: column;
        gap: 12px;
      }
      #hrd-source-pane.open { display: flex; }
      .hrd-src-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12.5px;
        color: var(--hr-muted);
        padding: 8px 12px;
        border-radius: 8px;
        background: var(--hrd-panel-bg);
        border: 1px solid var(--hr-rule);
      }
      .hrd-src-card {
        border: 1px solid var(--hr-rule);
        border-radius: 8px;
        background: var(--hrd-card-bg);
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .hrd-src-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11.5px;
        color: var(--hr-muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .hrd-src-ta {
        width: 100%;
        box-sizing: border-box;
        min-height: 76px;
        padding: 8px 10px;
        border-radius: 6px;
        border: 1px solid var(--hr-rule);
        background: var(--hrd-panel-bg);
        color: var(--hr-ink);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12.5px;
        line-height: 1.5;
        resize: vertical;
        outline: none;
      }
      .hrd-src-ta:focus { border-color: var(--hr-accent); }
      #hr-notes {
        grid-column: 3 !important;
        background: var(--hrd-panel-bg);
        border-left: 1px solid var(--hr-rule) !important;
        padding: 12px !important;
        font-size: 12.5px;
      }
      #hr-root:not(.hrd-notes-open) #hr-notes {
        overflow: hidden !important;
        padding: 0 !important;
        border-left: none !important;
        opacity: 0;
        pointer-events: none;
      }
      .hrd-notes-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 8px;
        margin-bottom: 10px;
        border-bottom: 1px solid var(--hr-rule);
        font-weight: 600;
        font-size: 13px;
      }
      #hr-notes-title { display: none !important; }
      #hr-notes .notes-group h4 {
        font-size: 11.5px;
        color: var(--hr-muted);
        margin: 10px 0 6px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      #hr-notes:has([data-hr-annotation]) #hr-notes-body { display: none; }
      #hr-notes [data-hr-annotation] {
        list-style: none;
        background: var(--hrd-card-bg);
        border: 1px solid var(--hr-rule);
        border-radius: 7px;
        padding: 8px 10px;
        margin: 6px 0;
        cursor: pointer;
      }
      #hr-notes [data-hr-annotation]:hover { border-color: var(--hr-accent); }
      #hr-notes [data-hr-annotation] p { margin: 2px 0; }
      #hr-note-draft {
        width: 100%;
        box-sizing: border-box;
        margin-top: 4px;
        padding: 7px 8px;
        border-radius: 6px;
        border: 1px solid var(--hr-rule);
        background: var(--hrd-card-bg);
        color: var(--hr-ink);
        font-family: inherit;
        font-size: 12.5px;
      }
      .note-editor-actions { display: flex; gap: 6px; margin-top: 6px; }
      .hrd-resolve-btn, .note-editor-actions button, #hr-note-btn {
        margin-top: 6px;
        font-size: 11.5px;
        padding: 3px 9px;
        border-radius: 5px;
        border: 1px solid var(--hr-rule);
        background: var(--hrd-card-bg);
        color: var(--hr-ink);
        cursor: pointer;
      }
      .hrd-resolve-btn:hover, .note-editor-actions button:hover, #hr-note-btn:hover {
        background: var(--hrd-active-soft);
      }
      #hrd-sb-hotzone {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        height: 22px;
        z-index: 440;
        background: transparent;
      }
      #hr-statusbar {
        position: fixed !important;
        left: 50%;
        bottom: 14px;
        transform: translate(-50%, 10px);
        height: 36px !important;
        max-width: calc(100vw - 32px);
        overflow-x: auto;
        border-radius: 999px;
        background: var(--hrd-sb-bg) !important;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid var(--hrd-sb-border) !important;
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.06);
        padding: 0 10px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 6px !important;
        font-size: 11.5px !important;
        color: var(--hr-muted);
        user-select: none;
        box-sizing: border-box;
        z-index: 460 !important;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
      }
      #hr-statusbar.hrd-sb-visible {
        opacity: 1 !important;
        pointer-events: auto !important;
        transform: translate(-50%, 0);
      }
      body[data-hrd-bar="bar"] #hr-statusbar {
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        max-width: 100vw !important;
        width: 100vw !important;
        height: 32px !important;
        border-radius: 0 !important;
        border: none !important;
        border-top: 1px solid var(--hr-rule) !important;
        box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.08);
        padding: 0 12px !important;
        transform: translateY(100%);
      }
      body[data-hrd-bar="bar"] #hr-statusbar.hrd-sb-visible {
        transform: translateY(0);
      }
      #hr-version, #hr-shortcuts { display: none !important; }
      .hrd-sb-group { display: flex; align-items: center; gap: 2px; min-width: 0; flex-shrink: 0; }
      .hrd-sb-btn {
        background: transparent;
        border: none;
        color: var(--hr-muted);
        height: 24px;
        padding: 0 8px;
        border-radius: 6px;
        font-size: 11.5px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
      }
      body[data-hrd-bar="floating"] .hrd-sb-btn {
        border-radius: 999px;
      }
      .hrd-sb-btn:hover { background: var(--hrd-hover); color: var(--hr-ink); }
      .hrd-sb-btn.active { background: var(--hrd-active-soft); color: var(--hr-ink); font-weight: 600; }
      .hrd-sb-sep {
        width: 1px;
        height: 13px;
        background: var(--hr-rule);
        margin: 0 4px;
        flex-shrink: 0;
      }
      .hrd-badge-count {
        background: var(--hr-accent);
        color: #ffffff;
        font-size: 10px;
        font-weight: 600;
        padding: 0 5px;
        height: 15px;
        line-height: 15px;
        border-radius: 8px;
      }
      .hrd-badge-count:empty { display: none; }
      #hr-conn { padding: 0 4px; font-size: 11px; white-space: nowrap; }
      #hrd-save-state { font-size: 11px; color: var(--hr-muted); padding: 0 4px; }
      #hr-hint { font-size: 11px; color: var(--hr-accent); white-space: nowrap; }
      .hrd-btn {
        background: var(--hrd-card-bg);
        color: var(--hr-ink);
        border: 1px solid var(--hr-rule);
        border-radius: 6px;
        height: 28px;
        padding: 0 10px;
        font-size: 12px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
      .hrd-btn:hover { background: var(--hrd-hover); }
      .hrd-btn-primary {
        background: var(--hr-accent);
        color: #ffffff;
        border-color: var(--hr-accent);
      }
      .hrd-btn-primary:hover { opacity: 0.92; background: var(--hr-accent); }
      .hrd-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.36);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .hrd-modal-backdrop.open { display: flex; }
      .hrd-modal {
        width: min(540px, 92vw);
        max-height: 84vh;
        overflow-y: auto;
        background: var(--hrd-card-bg);
        color: var(--hr-ink);
        border: 1px solid var(--hr-rule);
        border-radius: 12px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.28);
        padding: 18px 20px;
      }
      .hrd-modal h3 { margin: 0 0 12px; font-size: 15.5px; }
      .hrd-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 0;
        border-bottom: 1px solid var(--hr-rule);
        font-size: 13px;
      }
      .hrd-field input[type="text"], .hrd-field select {
        min-width: 190px;
        padding: 5px 8px;
        border-radius: 6px;
        border: 1px solid var(--hr-rule);
        background: var(--hrd-panel-bg);
        color: var(--hr-ink);
      }
      .hrd-modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 14px;
      }
      #hr-desktop-toast {
        position: fixed;
        right: 16px;
        bottom: 40px;
        background: #23262e;
        color: #ffffff;
        padding: 7px 13px;
        border-radius: 8px;
        font-size: 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.16s ease;
        z-index: 1200;
      }
      #hr-desktop-toast.show { opacity: 1; }
      #hr-desktop-toast.err { background: #9b2226; }
      .hrd-empty-state {
        min-height: calc(100vh - 180px);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 36px 20px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
      }
      .hrd-empty-mark {
        width: 56px;
        height: 56px;
        border-radius: 14px;
        background: var(--hrd-panel-bg);
        border: 1px solid var(--hr-rule);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--hr-ink);
        margin-bottom: 18px;
      }
      .hrd-empty-title {
        margin: 0 0 8px;
        font-size: 19px;
        font-weight: 600;
        color: var(--hr-ink);
        letter-spacing: -0.01em;
      }
      .hrd-empty-sub {
        margin: 0 0 14px;
        max-width: 440px;
        font-size: 13px;
        line-height: 1.65;
        color: var(--hr-muted);
      }
      .hrd-empty-path {
        max-width: min(520px, 84vw);
        padding: 5px 11px;
        margin-bottom: 22px;
        border-radius: 7px;
        background: var(--hrd-panel-bg);
        border: 1px solid var(--hr-rule);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px;
        color: var(--hr-muted);
        word-break: break-all;
      }
      .hrd-empty-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
        margin-bottom: 14px;
      }
      .hrd-empty-actions .hrd-btn {
        height: 32px;
        padding: 0 14px;
        font-size: 12.5px;
      }
      .hrd-empty-link {
        background: transparent;
        border: none;
        padding: 4px 8px;
        font-size: 12px;
        color: var(--hr-muted);
        cursor: pointer;
        border-radius: 6px;
      }
      .hrd-empty-link:hover {
        color: var(--hr-ink);
        background: var(--hrd-hover);
      }
    `;
    document.head.appendChild(style);
  }

  function customThemesList() {
    return Array.isArray(ctx.customThemes) ? ctx.customThemes : [];
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
    const vars = themeObj.vars && typeof themeObj.vars === "object"
      ? Object.entries(themeObj.vars)
          .filter(([k, v]) => typeof k === "string" && k.startsWith("--") && typeof v === "string")
          .map(([k, v]) => "  " + k + ": " + v + ";")
          .join("\n")
      : "";
    const extraCss = typeof themeObj.css === "string" ? themeObj.css : "";
    styleEl.textContent = (vars ? ":root, body {\n" + vars + "\n}\n" : "") + extraCss;
  }

  function applyPrefs() {
    const selected = String(prefs.uiTheme || "light");
    let effectiveBase = selected;
    let customObj = null;
    if (selected !== "light" && selected !== "paper" && selected !== "dark") {
      customObj = customThemesList().find((t) => t.id === selected) || null;
      if (customObj) {
        effectiveBase = customObj.base === "paper" || customObj.base === "dark" ? customObj.base : "light";
      } else {
        effectiveBase = "light";
        prefs = { ...prefs, uiTheme: "light" };
      }
    }
    applyCustomThemeStyle(customObj);
    document.body.setAttribute("data-hrd-os", ctx.isMacos ? "macos" : "other");
    document.body.setAttribute("data-hrd-bar", prefs.bottomBarStyle === "bar" ? "bar" : "floating");
    document.body.setAttribute("data-hrd-theme", effectiveBase);
    document.documentElement.setAttribute("data-hr-mode", effectiveBase === "dark" ? "dark" : "light");
    document.body.setAttribute("data-hrd-ids", prefs.showBlockIds ? "true" : "false");
    document.body.setAttribute("data-hrd-focus", prefs.focusMode ? "true" : "false");
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--hrd-font-size", String(prefs.fontSize) + "px");
    rootStyle.setProperty("--hrd-line-height", String(prefs.lineHeight));
    rootStyle.setProperty("--hrd-doc-width", prefs.maxWidth);
    const focusBtn = document.getElementById("hrd-sb-focus");
    if (focusBtn) focusBtn.classList.toggle("active", Boolean(prefs.focusMode));
  }

  let toastTimer = null;
  function showToast(msg, isError) {
    let el = document.getElementById("hr-desktop-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "hr-desktop-toast";
      document.body.appendChild(el);
    }
    el.textContent = String(msg);
    el.className = isError ? "show err" : "show";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ""; }, 2600);
  }
  window.__hrDesktopToast = showToast;

  function setSaveState(text) {
    const el = document.getElementById("hrd-save-state");
    if (el) el.textContent = text;
  }

  async function apiPost(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "x-hr-csrf": "1"
      },
      body: JSON.stringify(payload || {})
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) {
      throw new Error(json.message || json.code || ("HTTP " + res.status));
    }
    return json;
  }

  function bridgeNavigate(path) {
    if (path === "/pick-folder") {
      try {
        window.sessionStorage.removeItem("hrd_sidebar_tab");
        window.sessionStorage.removeItem("hrd_auto_outline");
      } catch {}
    }
    window.location.href = "http://hr-desktop.local" + path;
  }

  const COMPONENTS = [
    { id: "h2", label: "二级标题 H2", tag: "标题", html: "<h2>新章节标题</h2>" },
    { id: "h3", label: "三级标题 H3", tag: "标题", html: "<h3>小节标题</h3>" },
    {
      id: "kpi-bento",
      label: "KPI 指标卡阵 (kpi-bento)",
      tag: "数据",
      html: '<div data-hr-component="kpi-bento"><div><p><strong>38%</strong></p><p>关键指标变化</p></div><div><p><strong>12 ms</strong></p><p>核心延迟实测</p></div><div><p><strong>100%</strong></p><p>自动化覆盖率</p></div></div>'
    },
    {
      id: "callout-insight",
      label: "洞察高亮块 (callout-insight)",
      tag: "判断",
      html: '<div data-hr-component="callout-insight"><p>结论先行：在此写下一条需要读者记住的关键判断与事实依据。</p></div>'
    },
    {
      id: "callout-warning",
      label: "风险提示块 (callout-warning)",
      tag: "代价",
      html: '<div data-hr-component="callout-warning"><p>风险提示：明确列出方案的代价、前置条件与回滚边界。</p></div>'
    },
    {
      id: "split-compare",
      label: "左右对比分栏 (split-compare)",
      tag: "对照",
      html: '<div data-hr-component="split-compare"><div><p><strong>方案 A</strong></p><p>上手更快，改造成本低。</p></div><div><p><strong>方案 B</strong></p><p>隔离更强，长期扩展性好。</p></div></div>'
    },
    {
      id: "deep-dive",
      label: "深度推演折叠 (deep-dive)",
      tag: "细节",
      html: '<details data-hr-component="deep-dive"><summary>展开：查看推演细节与口径说明</summary><p>这里放置可跳过的详细推演步骤或原始数据来源。</p></details>'
    },
    {
      id: "step-timeline",
      label: "步骤时间线 (step-timeline)",
      tag: "流程",
      html: '<ol data-hr-component="step-timeline"><li><p><strong>第 1 步 · 准备</strong></p><p>完成现状评估与备份。</p></li><li><p><strong>第 2 步 · 实施</strong></p><p>按计划灰度推进。</p></li><li><p><strong>第 3 步 · 验收</strong></p><p>核对指标后正式收尾。</p></li></ol>'
    },
    {
      id: "diagram-stage",
      label: "图表舞台 (diagram-stage)",
      tag: "图示",
      html: '<figure data-hr-component="diagram-stage"><svg viewBox="0 0 640 120" width="640" height="120" role="img" aria-label="流程示意图"><rect x="20" y="25" width="160" height="70" rx="8" fill="#efe7d6" stroke="#7a4b1f"/><text x="100" y="65" text-anchor="middle" font-size="14" fill="#1b1a17">1. 输入与解析</text><line x1="180" y1="60" x2="240" y2="60" stroke="#7a4b1f" stroke-width="2"/><rect x="240" y="25" width="160" height="70" rx="8" fill="#efe7d6" stroke="#7a4b1f"/><text x="320" y="65" text-anchor="middle" font-size="14" fill="#1b1a17">2. 结构化改写</text><line x1="400" y1="60" x2="460" y2="60" stroke="#7a4b1f" stroke-width="2"/><rect x="460" y="25" width="160" height="70" rx="8" fill="#efe7d6" stroke="#7a4b1f"/><text x="540" y="65" text-anchor="middle" font-size="14" fill="#1b1a17">3. 排版与发布</text></svg><figcaption>图 1 · 结构化写作流程示意（右键或点右侧菜单可编辑 SVG）</figcaption></figure>'
    }
  ];

  function contentBlocks() {
    const direct = [...document.querySelectorAll("#hr-doc article[data-hr-id] > [data-hr-id]")];
    return direct.length ? direct : [...document.querySelectorAll("#hr-doc [data-hr-id]:not(article)")];
  }

  function closestTopBlock(node) {
    if (!(node instanceof Element)) return null;
    const comp = node.closest("#hr-doc [data-hr-component][data-hr-id]");
    if (comp) return comp;
    return (
      node.closest("#hr-doc article[data-hr-id] > [data-hr-id]") ||
      node.closest("#hr-doc [data-hr-id]:not(article)")
    );
  }

  function activeBlockEl() {
    const active = document.querySelector("#hr-doc .doc__block--on[data-hr-id]:not(article)");
    if (active) return closestTopBlock(active) || active;
    if (document.activeElement instanceof Element) {
      const focused = closestTopBlock(document.activeElement);
      if (focused) return focused;
    }
    return contentBlocks()[0] || null;
  }

  function cleanBlockClone(el) {
    const clone = el.cloneNode(true);
    clone.removeAttribute("contenteditable");
    for (const nested of clone.querySelectorAll("[contenteditable]")) {
      nested.removeAttribute("contenteditable");
    }
    clone.classList.remove("doc__block--on", "hr-note-target", "hr-flash");
    if (clone.getAttribute("class") === "") clone.removeAttribute("class");
    return clone;
  }

  const INLINE_TAGS = new Set(["strong", "b", "em", "i", "code", "a", "del", "s", "mark", "sup", "sub"]);
  function serializeNodeInner(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeHtmlText((node.nodeValue || "").replace(/\u00a0/g, " "));
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    if (tag === "br") return "<br/>";
    let inner = "";
    for (const child of node.childNodes) inner += serializeNodeInner(child);
    if (!INLINE_TAGS.has(tag)) return inner;
    let attrs = "";
    if (tag === "a") {
      const href = node.getAttribute("href");
      if (href) attrs += ' href="' + escapeHtmlText(href) + '"';
    }
    return "<" + tag + attrs + ">" + inner + "</" + tag + ">";
  }

  function serializeBlockHtml(el, tagOverride) {
    const tag = (tagOverride || el.tagName).toLowerCase();
    let inner = "";
    for (const child of el.childNodes) inner += serializeNodeInner(child);
    inner = inner.replace(/(?:<br\/>)+$/i, "");
    return "<" + tag + ">" + inner + "</" + tag + ">";
  }

  async function patchNode(targetId, action, fragment) {
    const docId = currentDocId();
    if (!docId || !targetId) {
      showToast("未选中可编辑节点", true);
      return null;
    }
    const body = { docId, targetId, action };
    if (action !== "delete") body.fragment = fragment;
    return await apiPost("/api/patch", body);
  }

  function enqueuePatch(fn) {
    saveInFlight = saveInFlight.then(fn, fn);
    return saveInFlight;
  }

  function focusBlockById(id, atEnd, attemptsLeft, expectedTag) {
    const tries = attemptsLeft === undefined ? 30 : attemptsLeft;
    const el = document.querySelector('#hr-doc [data-hr-id="' + CSS.escape(id) + '"]');
    const tagOk = !expectedTag || (el && el.tagName.toLowerCase() === expectedTag);
    if (el && isSimpleEditableBlock(el) && tagOk) {
      enableBlockEditable(el);
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(!atEnd);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return;
    }
    if (tries > 0) {
      setTimeout(() => focusBlockById(id, atEnd, tries - 1, expectedTag), 35);
    }
  }

  function flushBlockSave(el, tagOverride) {
    if (isEmptyMode()) return Promise.resolve(null);
    if (!el || !el.isConnected) return Promise.resolve(null);
    const id = el.getAttribute("data-hr-id");
    if (!id) return Promise.resolve(null);
    if (!editDirty && !tagOverride) return Promise.resolve(null);
    editDirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const fragment = serializeBlockHtml(el, tagOverride);
    setSaveState("保存中…");
    return enqueuePatch(async () => {
      try {
        const res = await patchNode(id, "replace", fragment);
        setSaveState("已保存");
        setTimeout(() => {
          const cur = document.getElementById("hrd-save-state");
          if (cur && cur.textContent === "已保存") cur.textContent = "";
        }, 1600);
        return res;
      } catch (err) {
        setSaveState("");
        showToast("保存失败：" + err.message, true);
        return null;
      }
    });
  }

  function enableBlockEditable(el) {
    if (!isSimpleEditableBlock(el)) return;
    if (el.getAttribute("contenteditable") !== EDITABLE_VALUE) {
      el.setAttribute("contenteditable", EDITABLE_VALUE);
    }
  }

  function syncAllEditables() {
    for (const block of contentBlocks()) {
      if (isSimpleEditableBlock(block)) enableBlockEditable(block);
    }
  }

  async function convertBlockTag(el, newTag) {
    if (isEmptyMode()) {
      showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
      return;
    }
    const target = el || activeBlockEl();
    if (!target) return;
    const id = target.getAttribute("data-hr-id");
    if (!id) return;
    if (!isSimpleEditableBlock(target)) {
      showToast("结构化组件请使用 HTML 源码编辑", true);
      return;
    }
    const text = (target.textContent || "").trim();
    const fragment = "<" + newTag + ">" + escapeHtmlText(text) + "</" + newTag + ">";
    editDirty = false;
    setSaveState("保存中…");
    await enqueuePatch(async () => {
      try {
        await patchNode(id, "replace", fragment);
        setSaveState("已保存");
        focusBlockById(id, true, 30, newTag);
      } catch (err) {
        setSaveState("");
        showToast("转换失败：" + err.message, true);
      }
    });
  }

  function tryMarkdownPrefix(el) {
    if (el.tagName.toLowerCase() !== "p") return false;
    const raw = (el.textContent || "").replace(/\u00a0/g, " ");
    const rules = [
      { re: /^# ([\s\S]*)$/, tag: "h1" },
      { re: /^## ([\s\S]*)$/, tag: "h2" },
      { re: /^### ([\s\S]*)$/, tag: "h3" },
      { re: /^#### ([\s\S]*)$/, tag: "h4" },
      { re: /^> ([\s\S]*)$/, tag: "blockquote" }
    ];
    for (const rule of rules) {
      const m = rule.re.exec(raw);
      if (!m) continue;
      const rest = m[1] || "";
      const id = el.getAttribute("data-hr-id");
      editDirty = false;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      el.textContent = rest;
      const fragment = "<" + rule.tag + ">" + escapeHtmlText(rest) + "</" + rule.tag + ">";
      enqueuePatch(async () => {
        try {
          await patchNode(id, "replace", fragment);
          focusBlockById(id, true, 30, rule.tag);
        } catch (err) {
          showToast("转换失败：" + err.message, true);
        }
      });
      return true;
    }
    return false;
  }

  async function insertAfterBlock(el, fragment, label, focusNew) {
    if (isEmptyMode()) {
      showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
      return null;
    }
    const target = el || activeBlockEl();
    if (!target) {
      showToast("当前文档没有可插入位置的块", true);
      return null;
    }
    const targetId = target.getAttribute("data-hr-id");
    if (editDirty && activeEditId === targetId) {
      await flushBlockSave(target);
    }
    return await enqueuePatch(async () => {
      try {
        const res = await patchNode(targetId, "insert_after", fragment);
        if (label) showToast("已插入：" + label);
        const createdId = res && Array.isArray(res.newIds) && res.newIds[0];
        if (focusNew && createdId) {
          focusBlockById(createdId, false, 35);
        }
        return res;
      } catch (err) {
        showToast("插入失败：" + err.message, true);
        return null;
      }
    });
  }

  async function deleteBlock(el) {
    if (isEmptyMode()) {
      showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
      return;
    }
    const target = el || activeBlockEl();
    if (!target) return;
    const all = contentBlocks();
    if (all.length <= 1) {
      showToast("至少保留一个正文节点", true);
      return;
    }
    const idx = all.indexOf(target);
    const prev = idx > 0 ? all[idx - 1] : all[idx + 1];
    const prevId = prev ? prev.getAttribute("data-hr-id") : null;
    const targetId = target.getAttribute("data-hr-id");
    editDirty = false;
    activeEditId = null;
    await enqueuePatch(async () => {
      try {
        await patchNode(targetId, "delete");
        if (prevId) focusBlockById(prevId, true, 20);
      } catch (err) {
        showToast("删除失败：" + err.message, true);
      }
    });
  }

  async function undoDocument() {
    if (isEmptyMode()) {
      showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
      return;
    }
    const docId = currentDocId();
    if (!docId) return;
    try {
      await apiPost("/api/doc/" + encodeURIComponent(docId) + "/undo", {});
      showToast("已撤销上次文档快照");
    } catch (err) {
      showToast("无法撤销：" + err.message, true);
    }
  }

  async function persistStyle(visualId) {
    const docId = currentDocId();
    if (!docId || !visualId) return;
    await apiPost("/api/style", { docId, visualId });
    showToast("已应用并写入视觉主题：" + visualId);
  }

  function openNotesDrawer(open) {
    notesOpen = Boolean(open);
    const root = document.getElementById("hr-root");
    if (root) {
      root.classList.toggle("hrd-notes-open", notesOpen);
    }
    const btn = document.getElementById("hrd-sb-notes");
    if (btn) btn.classList.toggle("active", notesOpen);
  }

  function toggleLeftSidebar(forceOpen) {
    const root = document.getElementById("hr-root");
    if (!root) return;
    const hide = forceOpen !== undefined ? !forceOpen : !root.classList.contains("hrd-hide-left");
    root.classList.toggle("hrd-hide-left", hide);
    const btn = document.getElementById("hrd-sb-left");
    if (btn) btn.classList.toggle("active", !hide);
  }

  function renderSourcePane() {
    const pane = document.getElementById("hrd-source-pane");
    if (!pane || !sourceMode) return;
    const blocks = contentBlocks();
    pane.innerHTML = `
      <div class="hrd-src-banner">
        <span>HTML 源码视图（修改单个节点后点击「保存」，按 Cmd+/ 返回 Typora 排版视图）</span>
        <button type="button" class="hrd-btn" id="hrd-src-exit">返回排版视图</button>
      </div>
      ${blocks.map((el) => {
        const id = el.getAttribute("data-hr-id") || "";
        const clone = cleanBlockClone(el);
        const comp = el.getAttribute("data-hr-component");
        return `
          <div class="hrd-src-card" data-src-id="${escapeHtmlText(id)}">
            <div class="hrd-src-head">
              <span>&lt;${escapeHtmlText(el.tagName.toLowerCase())}&gt; · ${escapeHtmlText(id)}${comp ? " · " + escapeHtmlText(comp) : ""}</span>
              <button type="button" class="hrd-btn hrd-src-save" style="height:22px;padding:0 8px;font-size:11px;">保存 ⌘Enter</button>
            </div>
            <textarea class="hrd-src-ta">${escapeHtmlText(clone.outerHTML)}</textarea>
          </div>
        `;
      }).join("")}
    `;
  }

  function toggleSourceMode(force) {
    if (isEmptyMode()) {
      showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
      return;
    }
    sourceMode = force !== undefined ? Boolean(force) : !sourceMode;
    const docEl = document.getElementById("hr-doc");
    let pane = document.getElementById("hrd-source-pane");
    const canvas = document.getElementById("hr-canvas");
    if (!pane && canvas) {
      pane = document.createElement("div");
      pane.id = "hrd-source-pane";
      canvas.appendChild(pane);
      pane.addEventListener("click", async (e) => {
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
          await patchNode(id, "replace", ta.value.trim());
          showToast("源码已保存：" + id);
        } catch (err) {
          showToast("保存失败：" + err.message, true);
        }
      });
      pane.addEventListener("keydown", async (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          const card = e.target.closest("[data-src-id]");
          const btn = card && card.querySelector(".hrd-src-save");
          if (btn) {
            e.preventDefault();
            btn.click();
          }
        }
      });
    }
    if (docEl) docEl.style.display = sourceMode ? "none" : "";
    if (pane) pane.classList.toggle("open", sourceMode);
    const btn = document.getElementById("hrd-sb-source");
    if (btn) btn.classList.toggle("active", sourceMode);
    if (sourceMode) {
      hideGutter();
      renderSourcePane();
    }
  }

  function openBlockHtmlModal(el) {
    if (isEmptyMode()) {
      showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
      return;
    }
    const target = el || activeBlockEl();
    if (!target) {
      showToast("请先点击一个块", true);
      return;
    }
    const id = target.getAttribute("data-hr-id");
    const clone = cleanBlockClone(target);

    const m = ensureModal(
      "html-edit",
      "编辑节点 HTML · " + (id || ""),
      `
        <div style="font-size:12px;color:var(--hr-muted);margin-bottom:8px;">直接修改完整元素源码，保存后按文档规范重新注入 id 并保留历史快照。</div>
        <textarea id="hrd-mod-html-ta" class="hrd-src-ta" style="min-height:180px;"></textarea>
      `,
      `
        <button type="button" class="hrd-btn" id="hrd-mod-html-cancel">取消</button>
        <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-mod-html-save">保存 ⌘Enter</button>
      `
    );
    const ta = m.querySelector("#hrd-mod-html-ta");
    ta.value = clone.outerHTML;
    ta.focus();
    const save = async () => {
      try {
        await patchNode(id, "replace", ta.value.trim());
        closeModal();
        showToast("已保存 HTML 修改");
      } catch (err) {
        showToast("保存失败：" + err.message, true);
      }
    };
    m.querySelector("#hrd-mod-html-save").addEventListener("click", save);
    m.querySelector("#hrd-mod-html-cancel").addEventListener("click", closeModal);
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
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
      const pending = document.querySelectorAll('#hr-notes-pending [data-hr-annotation][data-hr-status="pending"]').length;
      notesBadge.textContent = pending > 0 ? String(pending) : "";
    }
  }

  const TREE_CHEV_RIGHT = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 2.5 3.5 3.5-3.5 3.5"/></svg>';
  const TREE_CHEV_DOWN = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m2.5 4.5 3.5 3.5 3.5-3.5"/></svg>';

  function treeStorageKey() {
    return "hrd_tree_open_" + String(ctx.workspace || "default");
  }

  function loadExpandedDirs() {
    try {
      const raw = window.localStorage.getItem(treeStorageKey());
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }

  function saveExpandedDirs(set) {
    try {
      window.localStorage.setItem(treeStorageKey(), JSON.stringify([...set]));
    } catch {}
  }

  let expandedDirs = loadExpandedDirs();
  let lastAutoExpandedDoc = "";

  function syncExpandedForActiveDoc() {
    expandedDirs = loadExpandedDirs();
    const active = currentDocId();
    if (!active || active === lastAutoExpandedDoc) return;
    lastAutoExpandedDoc = active;
    const parts = active.split("/");
    let changed = false;
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join("/");
      if (!expandedDirs.has(prefix)) {
        expandedDirs.add(prefix);
        changed = true;
      }
    }
    if (changed) saveExpandedDirs(expandedDirs);
  }

  function workspaceTreeNodes() {
    if (Array.isArray(ctx.tree) && ctx.tree.length > 0) return ctx.tree;
    const files = Array.isArray(ctx.files) ? ctx.files : [];
    const root = [];
    for (const file of files) {
      const parts = String(file).split("/").filter(Boolean);
      let cursor = root;
      for (let i = 0; i < parts.length; i += 1) {
        const name = parts[i];
        const path = parts.slice(0, i + 1).join("/");
        if (i === parts.length - 1) {
          cursor.push({ name, path, kind: "file", children: [] });
        } else {
          let dir = cursor.find((n) => n.kind === "dir" && n.name === name);
          if (!dir) {
            dir = { name, path, kind: "dir", children: [] };
            cursor.push(dir);
          }
          cursor = dir.children;
        }
      }
    }
    return root;
  }

  function filterTreeNodes(nodes, q) {
    if (!q) return nodes;
    const matched = [];
    for (const node of nodes) {
      if (node.kind === "dir") {
        const dirHits = node.name.toLowerCase().includes(q);
        const childHits = filterTreeNodes(node.children || [], dirHits ? "" : q);
        if (dirHits || childHits.length > 0) {
          matched.push({ ...node, children: childHits });
        }
      } else if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
        matched.push(node);
      }
    }
    return matched;
  }

  function countTreeStats(nodes) {
    let docs = 0;
    let dirs = 0;
    for (const node of nodes) {
      if (node.kind === "dir") {
        dirs += 1;
        const sub = countTreeStats(node.children || []);
        docs += sub.docs;
        dirs += sub.dirs;
      } else {
        docs += 1;
      }
    }
    return { docs, dirs };
  }

  function renderTreeRowsHtml(nodes, active, forceExpand) {
    return nodes.map((node) => {
      if (node.kind === "dir") {
        const isOpen = forceExpand || expandedDirs.has(node.path);
        const childHtml = renderTreeRowsHtml(node.children || [], active, forceExpand);
        return `
          <div class="hrd-tree-group">
            <button type="button" class="hrd-tree-row dir" data-hrd-dir="${escapeHtmlText(node.path)}" title="${escapeHtmlText(node.path)}">
              <span class="hrd-tree-chev">${isOpen ? TREE_CHEV_DOWN : TREE_CHEV_RIGHT}</span>
              <span class="hrd-tree-label">${escapeHtmlText(node.name)}</span>
            </button>
            <div class="hrd-tree-children ${isOpen ? "" : "collapsed"}">${childHtml}</div>
          </div>
        `;
      }
      const displayName = node.name.replace(/\.html?$/i, "");
      const isActive = node.path === active;
      return `
        <button type="button" class="hrd-tree-row file ${isActive ? "active" : ""}" data-hrd-file="${escapeHtmlText(node.path)}" title="${escapeHtmlText(node.path)}">
          <span class="hrd-tree-label">${escapeHtmlText(displayName)}</span>
          <span class="hrd-tree-tag">HTML</span>
        </button>
      `;
    }).join("");
  }

  function renderFilesPanel(filterText) {
    const panel = document.getElementById("hr-files-panel");
    if (!panel) return;
    syncExpandedForActiveDoc();
    const active = currentDocId();
    const q = (filterText || "").trim().toLowerCase();
    const rawTree = workspaceTreeNodes();
    const stats = countTreeStats(rawTree);
    const tree = filterTreeNodes(rawTree, q);
    const bodyHtml = renderTreeRowsHtml(tree, active, Boolean(q));

    panel.innerHTML = `
      <div class="hrd-tree-scroll">
        ${bodyHtml || '<div style="font-size:12px;color:var(--hr-muted);padding:10px 8px;">当前目录无匹配的 .html 笔记</div>'}
      </div>
      <div class="hrd-vault-foot">
        <span>${stats.docs} 篇笔记 · ${stats.dirs} 个文件夹</span>
        <button type="button" class="hrd-vault-new" id="hrd-vault-new-btn" title="新建笔记 (⌘N)">+ 新建笔记</button>
      </div>
    `;
  }

  function filterToc(filterText) {
    const toc = document.getElementById("hr-toc");
    if (!toc) return;
    const q = (filterText || "").trim().toLowerCase();
    for (const item of toc.children) {
      const txt = (item.textContent || "").toLowerCase();
      item.style.display = !q || txt.includes(q) ? "" : "none";
    }
  }

  function enhanceAnnotationCards() {
    const cards = document.querySelectorAll('#hr-notes-pending [data-hr-annotation][data-hr-status="pending"]');
    for (const card of cards) {
      if (card.querySelector(".hrd-resolve-btn")) continue;
      const anId = card.getAttribute("data-hr-annotation");
      if (!anId) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hrd-resolve-btn";
      btn.textContent = "✓ 解决并归档";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          const docId = currentDocId();
          await apiPost(
            "/api/doc/" + encodeURIComponent(docId) + "/annotations/" + encodeURIComponent(anId) + "/resolve",
            { docId, resolutionNote: "桌面端已确认" }
          );
          showToast("批注已归档");
        } catch (err) {
          showToast("归档失败：" + err.message, true);
        }
      });
      card.appendChild(btn);
    }
    renderStats();
  }

  function closeFloatMenu() {
    const menu = document.getElementById("hrd-float-menu");
    if (menu) menu.classList.remove("open");
    openMenuKind = null;
  }

  function openFloatMenu(kind, anchorEl, buildHtml, onPick) {
    let menu = document.getElementById("hrd-float-menu");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "hrd-float-menu";
      document.body.appendChild(menu);
    }
    if (openMenuKind === kind && menu.classList.contains("open")) {
      closeFloatMenu();
      return;
    }
    openMenuKind = kind;
    menu.innerHTML = buildHtml;
    menu.classList.add("open");
    const rect = anchorEl.getBoundingClientRect();
    const mw = Math.max(menu.offsetWidth, 196);
    const mh = menu.offsetHeight || 220;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - mw - 10);
    const top = rect.top > mh + 16 && rect.bottom > window.innerHeight - 160
      ? rect.top - mh - 6
      : Math.min(rect.bottom + 6, window.innerHeight - mh - 8);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.onclick = (e) => {
      e.stopPropagation();
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      closeFloatMenu();
      onPick(act);
    };
  }

  function hideGutter() {
    const g = document.getElementById("hrd-block-gutter");
    if (g) g.classList.remove("visible");
  }

  function positionGutter(el) {
    const canvas = document.getElementById("hr-canvas");
    const gutter = document.getElementById("hrd-block-gutter");
    if (!canvas || !gutter || !el || sourceMode) return;
    gutterBlock = el;
    const cRect = canvas.getBoundingClientRect();
    const bRect = el.getBoundingClientRect();
    const left = Math.max(4, bRect.left - cRect.left - 50);
    const top = bRect.top - cRect.top + canvas.scrollTop + 3;
    gutter.style.left = left + "px";
    gutter.style.top = top + "px";
    gutter.classList.add("visible");
  }

  function ensureGutter() {
    const canvas = document.getElementById("hr-canvas");
    if (!canvas || document.getElementById("hrd-block-gutter")) return;
    const gutter = document.createElement("div");
    gutter.id = "hrd-block-gutter";
    gutter.innerHTML = `
      <button type="button" class="hrd-gut-btn" id="hrd-gut-add" title="在下方插入段落或组件">+</button>
      <button type="button" class="hrd-gut-btn" id="hrd-gut-more" title="段落转换、编辑源码或删除">⋮</button>
    `;
    canvas.appendChild(gutter);
    gutter.addEventListener("mouseenter", () => {
      if (gutterTimer) clearTimeout(gutterTimer);
    });
    gutter.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = gutterBlock || activeBlockEl();
      if (!target) return;
      if (e.target.closest("#hrd-gut-add")) {
        openFloatMenu(
          "gutter-add",
          e.target.closest("#hrd-gut-add"),
          `
            <div class="hrd-menu-hdr">在当前块后插入</div>
            <button type="button" class="hrd-dd-item" data-act="para"><span>正文段落 P</span><span>Enter</span></button>
            ${COMPONENTS.map((c) => `<button type="button" class="hrd-dd-item" data-act="c:${escapeHtmlText(c.id)}"><span>${escapeHtmlText(c.label)}</span><span style="opacity:.6;font-size:11px;">${escapeHtmlText(c.tag)}</span></button>`).join("")}
          `,
          (act) => {
            if (act === "para") {
              insertAfterBlock(target, "<p></p>", null, true);
              return;
            }
            if (act && act.startsWith("c:")) {
              const comp = COMPONENTS.find((c) => c.id === act.slice(2));
              if (comp) insertAfterBlock(target, comp.html, comp.label, false);
            }
          }
        );
      } else if (e.target.closest("#hrd-gut-more")) {
        openFloatMenu(
          "gutter-more",
          e.target.closest("#hrd-gut-more"),
          `
            <div class="hrd-menu-hdr">块格式与操作</div>
            <button type="button" class="hrd-dd-item" data-act="tag:p"><span>转为正文 P</span></button>
            <button type="button" class="hrd-dd-item" data-act="tag:h1"><span>转为一级标题 H1</span><span>#</span></button>
            <button type="button" class="hrd-dd-item" data-act="tag:h2"><span>转为二级标题 H2</span><span>##</span></button>
            <button type="button" class="hrd-dd-item" data-act="tag:h3"><span>转为三级标题 H3</span><span>###</span></button>
            <button type="button" class="hrd-dd-item" data-act="tag:blockquote"><span>转为引用块</span><span>&gt;</span></button>
            <div class="hrd-dd-sep"></div>
            <button type="button" class="hrd-dd-item" data-act="html"><span>编辑节点 HTML…</span><span>⌘E</span></button>
            <button type="button" class="hrd-dd-item" data-act="note"><span>为整段添加批注</span><span>c</span></button>
            <button type="button" class="hrd-dd-item" data-act="del" style="color:#a3341a;"><span>删除此块</span></button>
          `,
          (act) => {
            if (!act) return;
            if (act.startsWith("tag:")) convertBlockTag(target, act.slice(4));
            else if (act === "html") openBlockHtmlModal(target);
            else if (act === "note") triggerWholeBlockNote(target);
            else if (act === "del") deleteBlock(target);
          }
        );
      }
    });
  }

  function triggerWholeBlockNote(el) {
    if (el) el.click();
    openNotesDrawer(true);
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
      openNotesDrawer(true);
      const noteBtn = document.getElementById("hr-note-btn");
      if (noteBtn && !noteBtn.hasAttribute("hidden")) noteBtn.click();
      setTimeout(() => {
        const draft = document.getElementById("hr-note-draft");
        if (draft) draft.focus();
      }, 30);
    });
    document.body.appendChild(pop);
  }

  function updateSelectionPopover() {
    const pop = document.getElementById("hrd-sel-pop");
    if (!pop) return;
    const sel = window.getSelection();
    const noteBtn = document.getElementById("hr-note-btn");
    if (!sel || sel.isCollapsed || !noteBtn || noteBtn.hasAttribute("hidden")) {
      pop.classList.remove("open");
      return;
    }
    const docEl = document.getElementById("hr-doc");
    if (!docEl || !sel.anchorNode || !docEl.contains(sel.anchorNode)) {
      pop.classList.remove("open");
      return;
    }
    const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    pop.style.left = Math.min(Math.max(12, rect.left), window.innerWidth - 120) + "px";
    pop.style.top = Math.max(8, rect.top - 34) + "px";
    pop.classList.add("open");
  }

  function ensureModal(id, title, bodyHtml, footerHtml) {
    hideGutter();
    closeFloatMenu();
    let backdrop = document.getElementById("hrd-modal-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "hrd-modal-backdrop";
      backdrop.className = "hrd-modal-backdrop";
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) backdrop.classList.remove("open");
      });
      backdrop.addEventListener("mouseup", (e) => e.stopPropagation());
      document.body.appendChild(backdrop);
    }
    backdrop.innerHTML = `
      <div class="hrd-modal" data-hrd-modal="${id}">
        <h3>${escapeHtmlText(title)}</h3>
        <div>${bodyHtml}</div>
        <div class="hrd-modal-actions">${footerHtml}</div>
      </div>
    `;
    backdrop.classList.add("open");
    return backdrop;
  }

  function closeModal() {
    const backdrop = document.getElementById("hrd-modal-backdrop");
    if (backdrop) backdrop.classList.remove("open");
  }

  function buildUiThemeOptionsHtml() {
    const customs = customThemesList();
    const customOpts = customs.length
      ? customs.map((t) => `<option value="${escapeHtmlText(t.id)}" ${prefs.uiTheme === t.id ? "selected" : ""}>${escapeHtmlText(t.name)}</option>`).join("")
      : '<option value="" disabled>暂无配置（点击下方打开目录）</option>';
    return `
      <optgroup label="内置外观">
        <option value="light" ${prefs.uiTheme === "light" ? "selected" : ""}>纯净原生白（默认）</option>
        <option value="paper" ${prefs.uiTheme === "paper" ? "selected" : ""}>暖纸典藏（Paper）</option>
        <option value="dark" ${prefs.uiTheme === "dark" ? "selected" : ""}>深色静谧（Dark）</option>
      </optgroup>
      <optgroup label="自定义主题 (~/.hreader/themes)">
        ${customOpts}
      </optgroup>
    `;
  }

  function openSettingsModal() {
    const themes = [...document.querySelectorAll("#hr-theme-select option")].map((o) => o.value);
    const themeOpts = (themes.length ? themes : ["atelier-editorial"])
      .map((t) => `<option value="${escapeHtmlText(t)}" ${t === prefs.defaultVisual ? "selected" : ""}>${escapeHtmlText(t)}</option>`)
      .join("");

    const m = ensureModal(
      "settings",
      "偏好设置",
      `
        <div class="hrd-field">
          <span>外观主题</span>
          <select id="hrd-set-uitheme">${buildUiThemeOptionsHtml()}</select>
        </div>
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
        <div class="hrd-field">
          <span>正文字号（px）</span>
          <select id="hrd-set-fontsize">
            ${[15, 16, 17, 18, 19, 20, 22].map((s) => `<option value="${s}" ${prefs.fontSize === s ? "selected" : ""}>${s} px</option>`).join("")}
          </select>
        </div>
        <div class="hrd-field">
          <span>正文行距</span>
          <select id="hrd-set-lh">
            ${[1.55, 1.65, 1.75, 1.85, 2.0].map((v) => `<option value="${v}" ${Number(prefs.lineHeight) === v ? "selected" : ""}>${v}</option>`).join("")}
          </select>
        </div>
        <div class="hrd-field">
          <span>阅读栏最大宽度</span>
          <select id="hrd-set-width">
            <option value="640px" ${prefs.maxWidth === "640px" ? "selected" : ""}>紧凑 640px</option>
            <option value="740px" ${prefs.maxWidth === "740px" ? "selected" : ""}>标准 740px（Typora 默认）</option>
            <option value="880px" ${prefs.maxWidth === "880px" ? "selected" : ""}>宽版 880px</option>
            <option value="100%" ${prefs.maxWidth === "100%" ? "selected" : ""}>铺满画布</option>
          </select>
        </div>
        <div class="hrd-field">
          <span>文档排版主题</span>
          <select id="hrd-set-visual">${themeOpts}</select>
        </div>
        <div class="hrd-field">
          <span>专注模式（淡化非当前段）</span>
          <input type="checkbox" id="hrd-set-focus" ${prefs.focusMode ? "checked" : ""}/>
        </div>
        <div class="hrd-field">
          <span>左侧边缘显示节点 ID 标号</span>
          <input type="checkbox" id="hrd-set-ids" ${prefs.showBlockIds ? "checked" : ""}/>
        </div>
        <div class="hrd-field" style="border-bottom:none;">
          <span>笔记库根目录（工作区）</span>
          <button type="button" class="hrd-btn" id="hrd-set-pick-ws">更改根目录…</button>
        </div>
        <div style="font-size:11.5px;color:var(--hr-muted);word-break:break-all;">${escapeHtmlText(ctx.workspace || "")}</div>
      `,
      `
        <button type="button" class="hrd-btn" id="hrd-set-reset">恢复默认</button>
        <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-set-done">完成</button>
      `
    );

    m.querySelector("#hrd-set-open-themes").addEventListener("click", () => {
      bridgeNavigate("/open-themes-dir");
    });
    m.querySelector("#hrd-set-reload-themes").addEventListener("click", () => {
      bridgeNavigate("/reload-themes");
      setTimeout(() => {
        const sel = document.getElementById("hrd-set-uitheme");
        if (sel) sel.innerHTML = buildUiThemeOptionsHtml();
      }, 140);
    });
    m.querySelector("#hrd-set-pick-ws").addEventListener("click", () => {
      closeModal();
      bridgeNavigate("/pick-folder");
    });
    m.querySelector("#hrd-set-reset").addEventListener("click", () => {
      prefs = savePrefs({ ...DEFAULT_PREFS });
      applyPrefs();
      closeModal();
      showToast("已恢复默认设置");
    });
    m.querySelector("#hrd-set-done").addEventListener("click", async () => {
      const visual = m.querySelector("#hrd-set-visual").value;
      prefs = savePrefs({
        uiTheme: m.querySelector("#hrd-set-uitheme").value || "light",
        bottomBarStyle: m.querySelector("#hrd-set-barstyle").value,
        fontSize: Number(m.querySelector("#hrd-set-fontsize").value),
        lineHeight: Number(m.querySelector("#hrd-set-lh").value),
        maxWidth: m.querySelector("#hrd-set-width").value,
        focusMode: m.querySelector("#hrd-set-focus").checked,
        showBlockIds: m.querySelector("#hrd-set-ids").checked,
        defaultVisual: visual
      });
      applyPrefs();
      closeModal();
      const sel = document.getElementById("hr-theme-select");
      if (sel && visual && sel.value !== visual) {
        sel.value = visual;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        try { await persistStyle(visual); } catch {}
      } else {
        showToast("偏好设置已保存");
      }
    });
  }

  function openNewDocModal() {
    const m = ensureModal(
      "new-doc",
      "新建排版文档",
      `
        <div class="hrd-field">
          <span>文档标题</span>
          <input type="text" id="hrd-new-title" placeholder="例如：Q4 产品路线复盘" value="未命名文档"/>
        </div>
        <div class="hrd-field" style="border-bottom:none;">
          <span>文件名（自动补 .html）</span>
          <input type="text" id="hrd-new-name" placeholder="例如：q4-review.html"/>
        </div>
        <div style="font-size:11.5px;color:var(--hr-muted);">将创建在工作区：${escapeHtmlText(ctx.workspace || "")}</div>
      `,
      `
        <button type="button" class="hrd-btn" id="hrd-new-cancel">取消</button>
        <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-new-ok">创建并打开</button>
      `
    );
    const titleInput = m.querySelector("#hrd-new-title");
    const nameInput = m.querySelector("#hrd-new-name");
    titleInput.focus();
    titleInput.select();
    m.querySelector("#hrd-new-cancel").addEventListener("click", closeModal);
    const submit = () => {
      const title = titleInput.value.trim() || "未命名文档";
      const file = nameInput.value.trim();
      closeModal();
      bridgeNavigate("/new?title=" + encodeURIComponent(title) + "&file=" + encodeURIComponent(file));
    };
    m.querySelector("#hrd-new-ok").addEventListener("click", submit);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  }

  function openFileSwitcherModal() {
    const files = Array.isArray(ctx.files) ? ctx.files : [];
    const active = currentDocId();
    const m = ensureModal(
      "open-doc",
      "快速打开文档",
      `
        <div style="font-size:12px;color:var(--hr-muted);margin-bottom:8px;">当前工作区：${escapeHtmlText(ctx.workspace || "")}</div>
        <input type="text" id="hrd-open-filter" placeholder="输入文件名过滤…" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--hr-rule);background:var(--hrd-panel-bg);color:var(--hr-ink);margin-bottom:8px;"/>
        <div id="hrd-open-list" style="max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;"></div>
      `,
      `
        <button type="button" class="hrd-btn" id="hrd-open-finder">从访达选取 .html…</button>
        <button type="button" class="hrd-btn" id="hrd-open-folder">切换工作区…</button>
        <button type="button" class="hrd-btn" id="hrd-open-close">关闭</button>
      `
    );
    const listEl = m.querySelector("#hrd-open-list");
    const filterEl = m.querySelector("#hrd-open-filter");
    const render = () => {
      const q = filterEl.value.trim().toLowerCase();
      const matched = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
      listEl.innerHTML = matched.map((f) => `
        <button type="button" class="hrd-file-item ${f === active ? "active" : ""}" data-open="${escapeHtmlText(f)}">
          <span>📄 ${escapeHtmlText(f)}</span>
          <span style="font-size:11px;color:var(--hr-muted);">${f === active ? "当前" : "打开"}</span>
        </button>
      `).join("") || '<div style="padding:8px;font-size:12px;color:var(--hr-muted);">没有匹配文件</div>';
    };
    render();
    filterEl.addEventListener("input", render);
    listEl.addEventListener("click", (e) => {
      const item = e.target.closest("[data-open]");
      if (!item) return;
      const doc = item.getAttribute("data-open");
      closeModal();
      bridgeNavigate("/open?doc=" + encodeURIComponent(doc));
    });
    m.querySelector("#hrd-open-finder").addEventListener("click", () => {
      closeModal();
      bridgeNavigate("/pick-file");
    });
    m.querySelector("#hrd-open-folder").addEventListener("click", () => {
      closeModal();
      bridgeNavigate("/pick-folder");
    });
    m.querySelector("#hrd-open-close").addEventListener("click", closeModal);
    filterEl.focus();
  }

  function openComponentModal() {
    if (isEmptyMode()) {
      showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
      return;
    }
    const m = ensureModal(
      "components",
      "插入结构化排版组件（将在当前选中块后插入）",
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        ${COMPONENTS.map((c) => `
          <button type="button" class="hrd-btn" data-comp="${escapeHtmlText(c.id)}" style="height:auto;padding:10px;justify-content:space-between;">
            <span>${escapeHtmlText(c.label)}</span>
            <span style="font-size:10px;opacity:0.7;">${escapeHtmlText(c.tag)}</span>
          </button>
        `).join("")}
      </div>`,
      `<button type="button" class="hrd-btn" id="hrd-comp-close">关闭</button>`
    );
    m.querySelector("#hrd-comp-close").addEventListener("click", closeModal);
    m.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-comp]");
      if (!btn) return;
      const comp = COMPONENTS.find((c) => c.id === btn.getAttribute("data-comp"));
      closeModal();
      if (comp) insertAfterBlock(activeBlockEl(), comp.html, comp.label, false);
    });
  }

  function openHelpModal() {
    const m = ensureModal(
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
        <div class="hrd-field" style="border-bottom:none;"><span>过滤大纲 / 整段批注 / 改动 Diff</span><code>/ · c · Shift+D</code></div>
      `,
      `
        <button type="button" class="hrd-btn" id="hrd-help-welcome">打开欢迎指南文档</button>
        <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-help-ok">知道了</button>
      `
    );
    m.querySelector("#hrd-help-welcome").addEventListener("click", () => {
      closeModal();
      bridgeNavigate("/welcome");
    });
    m.querySelector("#hrd-help-ok").addEventListener("click", closeModal);
  }

  function runExportAction(kind) {
    if (isEmptyMode()) {
      if (kind === "reveal") {
        bridgeNavigate("/reveal");
      } else {
        showToast("当前未打开文档，请先新建或打开一个 HTML 文件", true);
      }
      return;
    }
    const docId = currentDocId();
    if (kind === "print") {
      window.print();
      return;
    }
    if (kind === "reveal") {
      bridgeNavigate("/reveal?doc=" + encodeURIComponent(docId));
      return;
    }
    if (kind === "pdf" || kind === "png" || kind === "html") {
      showToast("正在生成 " + kind.toUpperCase() + "…");
      bridgeNavigate("/export-" + kind + "?doc=" + encodeURIComponent(docId));
    }
  }

  const SVG_TO_TOC = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="3" cy="4" r="1" fill="currentColor" stroke="none"/><path d="M6 4h7.5"/><circle cx="5.2" cy="8" r="1" fill="currentColor" stroke="none"/><path d="M8 8h5.5"/><circle cx="5.2" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M8 12h4.2"/></svg>';
  const SVG_TO_FILES = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.8A1 1 0 0 1 3 2.8h2.6l1.1 1.2H13a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/><path d="M5 8.2h6" stroke-width="1.2" opacity="0.65"/></svg>';
  const SVG_SEARCH = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><circle cx="7.2" cy="7.2" r="4.3"/><path d="m10.6 10.6 2.9 2.9"/></svg>';
  const SVG_VAULT = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"><path d="M1.8 4.2a1.2 1.2 0 0 1 1.2-1.2h3l1.3 1.5h5.7a1.2 1.2 0 0 1 1.2 1.2v6.1a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2Z"/></svg>';
  const SVG_SIDEBAR = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><rect x="1.8" y="2.5" width="12.4" height="11" rx="2"/><path d="M5.6 2.5v11"/></svg>';
  const SVG_SOURCE = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 4.5-3.3 3.5 3.3 3.5M10.5 4.5l3.3 3.5-3.3 3.5"/></svg>';
  const SVG_FOCUS = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/></svg>';
  const SVG_NOTES = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"><path d="M3 3h10v7.5H7.2L4 13v-2.5H3Z"/></svg>';
  const SVG_GEAR = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35"><circle cx="8" cy="8" r="2.2"/><path d="M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1" stroke-linecap="round"/></svg>';

  function workspaceBaseName() {
    const parts = String(ctx.workspace || "").split(/[/\\]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "Vault";
  }

  function renderSidebarHeader() {
    const head = document.getElementById("hrd-side-head");
    if (!head) return;
    if (activeSidebarTab === "files") {
      head.innerHTML = `
        <button type="button" class="hrd-vault-btn" id="hrd-ws-pick" title="切换笔记库根目录 (${escapeHtmlText(ctx.workspace || "")})">
          ${SVG_VAULT}
          <span class="hrd-vault-name">${escapeHtmlText(workspaceBaseName())}</span>
          <span style="font-size:10px;opacity:0.6;">▾</span>
        </button>
        <div class="hrd-side-actions">
          <button type="button" class="hrd-icon-btn" id="hrd-mode-toc" title="切换到大纲视图">${SVG_TO_TOC}</button>
          <button type="button" class="hrd-icon-btn ${searchOpen ? "active" : ""}" id="hrd-toggle-search" title="搜索文件或标题 ( / )">${SVG_SEARCH}</button>
        </div>
      `;
    } else {
      head.innerHTML = `
        <button type="button" class="hrd-icon-btn" id="hrd-mode-files" title="返回笔记库文件树">${SVG_TO_FILES}</button>
        <span class="hrd-sb-heading">OUTLINE</span>
        <button type="button" class="hrd-icon-btn ${searchOpen ? "active" : ""}" id="hrd-toggle-search" title="过滤大纲或文件 ( / )">${SVG_SEARCH}</button>
      `;
    }
  }

  function setSidebarMode(mode) {
    activeSidebarTab = mode === "toc" ? "toc" : "files";
    try {
      window.sessionStorage.setItem("hrd_sidebar_tab", activeSidebarTab);
    } catch {}
    renderSidebarHeader();
    const toc = document.getElementById("hr-toc");
    const filesPanel = document.getElementById("hr-files-panel");
    const search = document.getElementById("hr-search");
    if (toc) toc.classList.toggle("hidden", activeSidebarTab !== "toc");
    if (filesPanel) filesPanel.classList.toggle("active", activeSidebarTab === "files");
    if (activeSidebarTab === "files") renderFilesPanel(search ? search.value : "");
  }

  function toggleSearchBox(force) {
    const search = document.getElementById("hr-search");
    if (!search) return;
    searchOpen = force !== undefined ? Boolean(force) : !searchOpen;
    search.classList.toggle("open", searchOpen);
    const btn = document.getElementById("hrd-toggle-search");
    if (btn) btn.classList.toggle("active", searchOpen);
    if (searchOpen) {
      search.focus();
      search.select();
    } else {
      search.value = "";
      filterToc("");
      renderFilesPanel("");
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
      if (e.detail === 1) {
        e.preventDefault();
        e.stopImmediatePropagation();
        bridgeNavigate("/drag");
      } else if (e.detail === 2) {
        e.preventDefault();
        e.stopImmediatePropagation();
        bridgeNavigate("/toggle-maximize");
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

  function checkUnauthorizedRecovery() {
    const host = window.location.hostname;
    if (host !== "127.0.0.1" && host !== "localhost") return false;
    if (document.getElementById("hr-root")) return false;
    const text = (document.body && document.body.textContent) || "";
    if (!text.includes("访问凭据")) return false;
    const key = "hrd_reauth_tries_" + String(window.location.port || "0");
    try {
      const tries = Number(window.sessionStorage.getItem(key) || "0");
      if (tries >= 3) return false;
      window.sessionStorage.setItem(key, String(tries + 1));
    } catch {}
    bridgeNavigate("/reauth");
    return true;
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

    head.addEventListener("click", (e) => {
      if (e.target.closest("#hrd-ws-pick")) {
        bridgeNavigate("/pick-folder");
      } else if (e.target.closest("#hrd-mode-toc")) {
        setSidebarMode("toc");
      } else if (e.target.closest("#hrd-mode-files")) {
        setSidebarMode("files");
      } else if (e.target.closest("#hrd-toggle-search")) {
        toggleSearchBox();
      }
    });

    filesPanel.addEventListener("click", (e) => {
      if (e.target.closest("#hrd-vault-new-btn")) {
        openNewDocModal();
        return;
      }
      const dirBtn = e.target.closest("[data-hrd-dir]");
      if (dirBtn) {
        const dirPath = dirBtn.getAttribute("data-hrd-dir");
        if (dirPath) {
          if (expandedDirs.has(dirPath)) expandedDirs.delete(dirPath);
          else expandedDirs.add(dirPath);
          saveExpandedDirs(expandedDirs);
          renderFilesPanel(search.value);
        }
        return;
      }
      const item = e.target.closest("[data-hrd-file]");
      if (!item) return;
      const file = item.getAttribute("data-hrd-file");
      if (file) {
        try {
          window.sessionStorage.setItem("hrd_auto_outline", "1");
          window.sessionStorage.setItem("hrd_sidebar_tab", "toc");
        } catch {}
        bridgeNavigate("/open?doc=" + encodeURIComponent(file));
      }
    });

    search.addEventListener("input", () => {
      filterToc(search.value);
      renderFilesPanel(search.value);
    });

    setSidebarMode(activeSidebarTab);
  }

  function ensureOverlayTitlebar() {
    const canvas = document.getElementById("hr-canvas");
    if (!canvas || document.getElementById("hrd-overlay-title")) return;
    const bar = document.createElement("div");
    bar.id = "hrd-overlay-title";
    wireDragSurface(bar);
    canvas.prepend(bar);
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

  function showStatusbar() {
    if (sbHideTimer) {
      clearTimeout(sbHideTimer);
      sbHideTimer = null;
    }
    const sb = document.getElementById("hr-statusbar");
    if (sb) sb.classList.add("hrd-sb-visible");
  }

  function scheduleHideStatusbar() {
    if (sbHideTimer) clearTimeout(sbHideTimer);
    sbHideTimer = setTimeout(() => {
      const sb = document.getElementById("hr-statusbar");
      const menu = document.getElementById("hrd-float-menu");
      if (!sb) return;
      if (menu && menu.classList.contains("open")) return;
      if (sb.matches(":hover")) return;
      sb.classList.remove("hrd-sb-visible");
    }, 280);
  }

  function openAppearanceMenu(anchor) {
    const customs = customThemesList();
    const themeBtns = [
      { id: "light", label: "纯净原生白（默认）" },
      { id: "paper", label: "暖纸典藏 (Paper)" },
      { id: "dark", label: "深色静谧 (Dark)" },
      ...customs.map((t) => ({ id: t.id, label: t.name }))
    ]
      .map((t) => `<button type="button" class="hrd-dd-item" data-act="ui:${escapeHtmlText(t.id)}"><span>${escapeHtmlText(t.label)}</span><span>${prefs.uiTheme === t.id ? "✓" : ""}</span></button>`)
      .join("");
    const nextBar = prefs.bottomBarStyle === "bar" ? "floating" : "bar";
    const barLabel = prefs.bottomBarStyle === "bar" ? "切换为悬浮毛玻璃底栏" : "切换为贴边通栏底栏";
    openFloatMenu(
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
        if (act === "open-themes-dir") {
          bridgeNavigate("/open-themes-dir");
        } else if (act === "toggle-bar") {
          prefs = savePrefs({ ...prefs, bottomBarStyle: nextBar });
          applyPrefs();
          showStatusbar();
        } else if (act.startsWith("ui:")) {
          prefs = savePrefs({ ...prefs, uiTheme: act.slice(3) });
          applyPrefs();
        }
      }
    );
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

    const conn = document.getElementById("hr-conn");
    const hint = document.getElementById("hr-hint");

    const left = document.createElement("div");
    left.id = "hrd-sb-left-group";
    left.className = "hrd-sb-group";
    left.innerHTML = `
      <button type="button" class="hrd-sb-btn active" id="hrd-sb-left" title="显隐左侧边栏 (⌘⇧L)">${SVG_SIDEBAR}</button>
      <button type="button" class="hrd-sb-btn" id="hrd-sb-source" title="切换 HTML 源码模式 (⌘/)">${SVG_SOURCE}<span>源码</span></button>
      <button type="button" class="hrd-sb-btn" id="hrd-sb-focus" title="专注模式 (⌘⇧F)">${SVG_FOCUS}<span>专注</span></button>
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
      <button type="button" class="hrd-sb-btn" id="hrd-sb-notes" title="显隐批注栏 (⌘⇧R)">${SVG_NOTES}<span>批注</span><span id="hrd-sb-notes-count" class="hrd-badge-count"></span></button>
      <button type="button" class="hrd-sb-btn" id="hrd-sb-appearance" title="切换外观主题与底栏样式">外观</button>
      <button type="button" class="hrd-sb-btn" id="hrd-sb-export" title="导出与打印">导出</button>
      <button type="button" class="hrd-sb-btn" id="hrd-sb-settings" title="偏好设置 (⌘,)">${SVG_GEAR}</button>
    `;

    sb.prepend(left);
    sb.appendChild(mid);
    sb.appendChild(right);

    left.querySelector("#hrd-sb-left").addEventListener("click", () => toggleLeftSidebar());
    left.querySelector("#hrd-sb-source").addEventListener("click", () => toggleSourceMode());
    left.querySelector("#hrd-sb-focus").addEventListener("click", () => {
      prefs = savePrefs({ ...prefs, focusMode: !prefs.focusMode });
      applyPrefs();
    });
    left.querySelector("#hrd-sb-comp").addEventListener("click", openComponentModal);
    right.querySelector("#hrd-sb-notes").addEventListener("click", () => openNotesDrawer(!notesOpen));
    right.querySelector("#hrd-sb-settings").addEventListener("click", openSettingsModal);

    right.querySelector("#hrd-sb-appearance").addEventListener("click", (e) => {
      e.stopPropagation();
      openAppearanceMenu(e.currentTarget);
    });

    right.querySelector("#hrd-sb-export").addEventListener("click", (e) => {
      e.stopPropagation();
      openFloatMenu(
        "sb-export",
        e.currentTarget,
        `
          <button type="button" class="hrd-dd-item" data-act="pdf"><span>导出带书签 PDF</span><span>PDF</span></button>
          <button type="button" class="hrd-dd-item" data-act="png"><span>导出高清 PNG 长图</span><span>PNG</span></button>
          <button type="button" class="hrd-dd-item" data-act="html"><span>导出自包含打印 HTML</span><span>HTML</span></button>
          <div class="hrd-dd-sep"></div>
          <button type="button" class="hrd-dd-item" data-act="print"><span>系统打印…</span><span>⌘P</span></button>
          <button type="button" class="hrd-dd-item" data-act="reveal"><span>在文件夹中显示</span><span>目录</span></button>
        `,
        (act) => runExportAction(act)
      );
    });

    wordsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const doc = document.getElementById("hr-doc");
      const rawText = (doc && doc.innerText) || "";
      const nonSpace = rawText.replace(/\s+/g, "").length;
      const blocks = contentBlocks().length;
      const mins = Math.max(1, Math.ceil(nonSpace / 400));
      openFloatMenu(
        "sb-stats",
        e.currentTarget,
        `
          <div class="hrd-menu-hdr">文档统计</div>
          <div class="hrd-dd-item" style="cursor:default;"><span>字符数（不含空白）</span><strong>${nonSpace}</strong></div>
          <div class="hrd-dd-item" style="cursor:default;"><span>字符数（含空白）</span><strong>${rawText.length}</strong></div>
          <div class="hrd-dd-item" style="cursor:default;"><span>结构节点数</span><strong>${blocks} 块</strong></div>
          <div class="hrd-dd-item" style="cursor:default;"><span>预计阅读时长</span><strong>约 ${mins} 分钟</strong></div>
        `,
        () => {}
      );
    });
  }

  function renderEmptyState() {
    if (!isEmptyMode()) return;
    const docEl = document.getElementById("hr-doc");
    if (!docEl) return;
    docEl.innerHTML = `
      <div class="hrd-empty-state">
        <div class="hrd-empty-mark" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="4" width="6.2" height="24" rx="1.6" fill="currentColor"/>
            <path d="M12.2 15.2C14.8 11.8 18.4 10.8 21.8 11.8C24.9 12.7 26.5 15.3 26.5 19.1V28H20.3V19.9C20.3 17.5 19.2 16.4 17.3 16.4C15.1 16.4 13.4 18 12.2 20.1V15.2Z" fill="currentColor"/>
          </svg>
        </div>
        <h1 class="hrd-empty-title">当前目录暂无 HTML 笔记</h1>
        <p class="hrd-empty-sub">可以直接在当前工作区新建一篇排版文档，或者切换至包含 .html 文档的笔记库文件夹。</p>
        <div class="hrd-empty-path">${escapeHtmlText(ctx.workspace || "未选择工作区")}</div>
        <div class="hrd-empty-actions">
          <button type="button" class="hrd-btn hrd-btn-primary" id="hrd-empty-new">+ 新建文档</button>
          <button type="button" class="hrd-btn" id="hrd-empty-folder">选择笔记库文件夹…</button>
          <button type="button" class="hrd-btn" id="hrd-empty-file">打开 HTML 文件…</button>
        </div>
        <button type="button" class="hrd-empty-link" id="hrd-empty-welcome">生成欢迎指南文档 (welcome.html)</button>
      </div>
    `;
    const newBtn = docEl.querySelector("#hrd-empty-new");
    const folderBtn = docEl.querySelector("#hrd-empty-folder");
    const fileBtn = docEl.querySelector("#hrd-empty-file");
    const welcomeBtn = docEl.querySelector("#hrd-empty-welcome");
    if (newBtn) newBtn.addEventListener("click", openNewDocModal);
    if (folderBtn) folderBtn.addEventListener("click", () => bridgeNavigate("/pick-folder"));
    if (fileBtn) fileBtn.addEventListener("click", () => bridgeNavigate("/pick-file"));
    if (welcomeBtn) welcomeBtn.addEventListener("click", () => bridgeNavigate("/welcome"));

    const connEl = document.getElementById("hr-conn");
    if (connEl) connEl.textContent = "未打开文档";
    const wordsEl = document.getElementById("hrd-sb-words-txt");
    if (wordsEl) wordsEl.textContent = "0 字";
    const tocEl = document.getElementById("hr-toc");
    if (tocEl && !tocEl.children.length) {
      tocEl.innerHTML = '<li style="padding:10px 8px;font-size:12px;color:var(--hr-muted);">当前未打开文档</li>';
    }
  }

  function updateDocBadge() {
    const docId = currentDocId();
    document.title = docId ? docId + " — hReader" : workspaceBaseName() + " — hReader";
    const titleEl = document.getElementById("hrd-overlay-title");
    if (!titleEl) return;
    if (docId) {
      const parts = docId.split("/").filter(Boolean);
      const name = parts.pop() || docId;
      const prefix = parts.length ? parts.join(" / ") + " / " : "";
      titleEl.innerHTML = (prefix ? `<span>${escapeHtmlText(prefix)}</span>` : "") + `<span class="hrd-crumb-name">${escapeHtmlText(name)}</span>`;
    } else {
      titleEl.innerHTML = `<span class="hrd-crumb-name">${escapeHtmlText(workspaceBaseName())}</span><span> · 空白页</span>`;
    }
  }

  function wireDocInteractions(docEl) {
    if (docEl.dataset.hrdWired) return;
    docEl.dataset.hrdWired = "1";

    docEl.addEventListener("click", (e) => {
      const target = closestTopBlock(e.target);
      if (!target) return;
      positionGutter(target);
      if (isSimpleEditableBlock(target)) {
        enableBlockEditable(target);
        if (document.activeElement !== target) target.focus();
      }
    });

    docEl.addEventListener("dblclick", (e) => {
      const target = closestTopBlock(e.target);
      if (!target || isSimpleEditableBlock(target)) return;
      openBlockHtmlModal(target);
    });

    docEl.addEventListener("focusin", (e) => {
      const target = closestTopBlock(e.target);
      if (!target) return;
      activeEditId = target.getAttribute("data-hr-id");
      positionGutter(target);
    });

    docEl.addEventListener("focusout", (e) => {
      const target = closestTopBlock(e.target);
      if (!target) return;
      if (editDirty && activeEditId === target.getAttribute("data-hr-id")) {
        flushBlockSave(target);
      }
    });

    docEl.addEventListener("input", (e) => {
      const target = closestTopBlock(e.target);
      if (!target || !isSimpleEditableBlock(target)) return;
      lastInputAt = Date.now();
      activeEditId = target.getAttribute("data-hr-id");
      if (tryMarkdownPrefix(target)) return;
      editDirty = true;
      setSaveState("未保存");
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (document.contains(target)) flushBlockSave(target);
      }, 650);
    });

    docEl.addEventListener("keydown", async (e) => {
      const target = closestTopBlock(e.target);
      if (!target || !isSimpleEditableBlock(target)) return;
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        await insertAfterBlock(target, "<p></p>", null, true);
      } else if (e.key === "Backspace") {
        const clean = (target.textContent || "").replace(/\u00a0/g, "").trim();
        if (clean === "" && contentBlocks().length > 1) {
          e.preventDefault();
          await deleteBlock(target);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (editDirty) await flushBlockSave(target);
        target.blur();
      }
    });

    docEl.addEventListener("mouseover", (e) => {
      const target = closestTopBlock(e.target);
      if (!target) return;
      if (gutterTimer) clearTimeout(gutterTimer);
      positionGutter(target);
    });

    docEl.addEventListener("mouseleave", () => {
      gutterTimer = setTimeout(hideGutter, 380);
    });

    const obs = new MutationObserver(() => {
      syncAllEditables();
      ensureDefaultThemeLoaded();
      renderStats();
      if (sourceMode) renderSourcePane();
    });
    obs.observe(docEl, { childList: true, subtree: true });
  }

  let themeHydrated = false;
  function ensureDefaultThemeLoaded() {
    if (themeHydrated || isEmptyMode()) return;
    const styleEl = document.getElementById("hr-theme");
    if (!styleEl || (styleEl.textContent || "").trim() !== "") return;
    themeHydrated = true;
    const visual = prefs.defaultVisual || "atelier-editorial";
    fetch("/api/theme/" + encodeURIComponent(visual), { credentials: "same-origin" })
      .then((res) => (res.ok ? res.text() : ""))
      .then((css) => {
        if (css && (styleEl.textContent || "").trim() === "") {
          styleEl.textContent = css;
        }
      })
      .catch(() => {
        themeHydrated = false;
      });
  }

  function setupWorkbench() {
    if (checkUnauthorizedRecovery()) return;
    if (!document.getElementById("hr-root")) {
      ensureFallbackDragStrip();
      setTimeout(setupWorkbench, 40);
      return;
    }
    const fallbackDrag = document.getElementById("hrd-fallback-drag");
    if (fallbackDrag) fallbackDrag.remove();
    try {
      if (window.sessionStorage.getItem("hrd_auto_outline") === "1") {
        window.sessionStorage.removeItem("hrd_auto_outline");
        activeSidebarTab = "toc";
      }
    } catch {}
    if (isEmptyMode()) {
      activeSidebarTab = "files";
    }
    injectStyles();
    applyPrefs();
    ensureDefaultThemeLoaded();
    ensureOverlayTitlebar();
    buildSidebarEnhancements();
    buildNotesDrawerChrome();
    buildStatusbarEnhancements();
    ensureGutter();
    ensureSelectionPopover();
    updateDocBadge();
    renderEmptyState();
    syncAllEditables();
    renderStats();
    enhanceAnnotationCards();

    const docEl = document.getElementById("hr-doc");
    if (docEl) wireDocInteractions(docEl);

    const notesEl = document.getElementById("hr-notes");
    if (notesEl && !notesEl.dataset.hrdWired) {
      notesEl.dataset.hrdWired = "1";
      const nObs = new MutationObserver(() => {
        enhanceAnnotationCards();
        const editorOpen = document.getElementById("hr-note-editor")?.classList.contains("sidenote-editor--open");
        const diffOpen = document.getElementById("hr-diff")?.classList.contains("diff--open");
        const errTxt = (document.getElementById("hr-note-error")?.textContent || "").trim();
        if (editorOpen || diffOpen || errTxt) {
          openNotesDrawer(true);
        }
      });
      nObs.observe(notesEl, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    }

    const themeSel = document.getElementById("hr-theme-select");
    if (themeSel && !themeSel.dataset.hrdWired) {
      themeSel.dataset.hrdWired = "1";
      themeSel.addEventListener("change", () => {
        persistStyle(themeSel.value).catch((err) => showToast("写入主题失败：" + err.message, true));
      });
    }

    if (!document.body.dataset.hrdGlobalWired) {
      document.body.dataset.hrdGlobalWired = "1";
      document.addEventListener("click", () => {
        closeFloatMenu();
        scheduleHideStatusbar();
      });
      window.addEventListener("mouseup", () => setTimeout(updateSelectionPopover, 20));
      window.addEventListener(
        "mousemove",
        (e) => {
          if (e.clientY >= window.innerHeight - 24) showStatusbar();
        },
        { passive: true }
      );
      window.addEventListener(
        "wheel",
        (e) => {
          const t = e.target;
          if (!(t instanceof Element)) return;
          if (!t.closest("#hr-statusbar")) return;
          const canvas = document.getElementById("hr-canvas");
          if (canvas) canvas.scrollBy(0, e.deltaY);
        },
        { passive: true }
      );
    }
  }

  window.__hrDesktopSync = (nextCtx) => {
    if (checkUnauthorizedRecovery()) return;
    setupWorkbench();
    if (nextCtx && typeof nextCtx === "object") {
      const urlDoc = new URLSearchParams(window.location.search).get("doc");
      const syncKey = "hrd_doc_sync_" + window.location.port + "_" + String(nextCtx.docId || "");
      if (nextCtx.docId && urlDoc && urlDoc !== nextCtx.docId && !window.sessionStorage.getItem(syncKey)) {
        window.sessionStorage.setItem(syncKey, "1");
        window.location.replace("/?doc=" + encodeURIComponent(nextCtx.docId));
        return;
      }
      ctx = nextCtx;
      window.__HR_DESKTOP_CTX__ = ctx;
      applyPrefs();
      if (isEmptyMode()) {
        setSidebarMode("files");
        renderEmptyState();
      } else {
        renderSidebarHeader();
        const search = document.getElementById("hr-search");
        renderFilesPanel(search ? search.value : "");
      }
      updateDocBadge();
      const themeModalSel = document.getElementById("hrd-set-uitheme");
      if (themeModalSel) themeModalSel.innerHTML = buildUiThemeOptionsHtml();
    }
  };

  function isEditableFocus() {
    const el = document.activeElement;
    if (!(el instanceof Element)) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  window.__hrMenuAction = (action) => {
    if (action === "open-file") openFileSwitcherModal();
    else if (action === "pick-file") bridgeNavigate("/pick-file");
    else if (action === "pick-folder") bridgeNavigate("/pick-folder");
    else if (action === "new-file") openNewDocModal();
    else if (action === "open-themes-dir") bridgeNavigate("/open-themes-dir");
    else if (action === "reload-themes") bridgeNavigate("/reload-themes");
    else if (action === "save-doc") {
      const active = closestTopBlock(document.activeElement) || activeBlockEl();
      flushBlockSave(active).then(() => showToast("文档已保存"));
    } else if (action === "settings") openSettingsModal();
    else if (action === "welcome") bridgeNavigate("/welcome");
    else if (action === "help") openHelpModal();
    else if (action === "edit-block") openBlockHtmlModal(activeBlockEl());
    else if (action === "insert-para") insertAfterBlock(activeBlockEl(), "<p></p>", null, true);
    else if (action === "insert-comp") openComponentModal();
    else if (action === "delete-block") deleteBlock(activeBlockEl());
    else if (action === "undo") undoDocument();
    else if (action === "toggle-source") toggleSourceMode();
    else if (action === "toggle-left") toggleLeftSidebar();
    else if (action === "toggle-right") openNotesDrawer(!notesOpen);
    else if (action === "toggle-focus") {
      prefs = savePrefs({ ...prefs, focusMode: !prefs.focusMode });
      applyPrefs();
    } else if (action === "export-pdf") runExportAction("pdf");
    else if (action === "export-png") runExportAction("png");
    else if (action === "export-html") runExportAction("html");
    else if (action === "print") runExportAction("print");
    else if (action === "reveal") runExportAction("reveal");
    else if (action.startsWith("tag:")) convertBlockTag(activeBlockEl(), action.slice(4));
    else if (action.startsWith("comp:")) {
      const comp = COMPONENTS.find((c) => c.id === action.slice(5));
      if (comp) insertAfterBlock(activeBlockEl(), comp.html, comp.label, false);
    } else if (action.startsWith("theme:")) {
      const id = action.slice(6);
      const sel = document.getElementById("hr-theme-select");
      if (sel) {
        sel.value = id;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        persistStyle(id).catch((err) => showToast(err.message, true));
      }
    } else if (action.startsWith("ui:")) {
      prefs = savePrefs({ ...prefs, uiTheme: action.slice(3) });
      applyPrefs();
    }
  };

  // Capture-phase listener: intercept bare `/` for search & Typora Cmd shortcuts cleanly.
  window.addEventListener("keydown", (e) => {
    const editable = isEditableFocus();
    if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "/" && !editable) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleLeftSidebar(true);
        toggleSearchBox(true);
      }
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "o") { e.preventDefault(); openFileSwitcherModal(); }
    else if (k === "n") { e.preventDefault(); openNewDocModal(); }
    else if (k === ",") { e.preventDefault(); openSettingsModal(); }
    else if (k === "s") {
      e.preventDefault();
      window.__hrMenuAction("save-doc");
    } else if (k === "e") { e.preventDefault(); openBlockHtmlModal(activeBlockEl()); }
    else if (k === "/") { e.preventDefault(); toggleSourceMode(); }
    else if (k === "p") { e.preventDefault(); window.print(); }
    else if (k === "k" && e.shiftKey) { e.preventDefault(); openComponentModal(); }
    else if (k === "l" && e.shiftKey) { e.preventDefault(); toggleLeftSidebar(); }
    else if (k === "r" && e.shiftKey) { e.preventDefault(); openNotesDrawer(!notesOpen); }
    else if (k === "f" && e.shiftKey) { e.preventDefault(); window.__hrMenuAction("toggle-focus"); }
    else if (k === "z" && (e.shiftKey || !editable)) {
      e.preventDefault();
      undoDocument();
    }
  }, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupWorkbench);
  } else {
    setupWorkbench();
  }
  window.addEventListener("load", setupWorkbench);
})();
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_ws(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hr-wb-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn welcome_and_starter_contain_normalized_article() {
        let welcome = welcome_html();
        assert!(welcome.contains("<article data-hr-id=\"doc-root\">"));
        assert!(welcome.contains("data-hr-component=\"kpi-bento\""));
        assert!(welcome.contains("data-hr-component=\"callout-insight\""));

        let starter = starter_html("测试<标题>");
        assert!(starter.contains("<article data-hr-id=\"doc-root\">"));
        assert!(starter.contains("测试&lt;标题&gt;"));
    }

    #[test]
    fn list_html_files_filters_hidden_and_sorts() {
        let dir = temp_ws("files");
        fs::create_dir_all(dir.join(".hreader")).expect("dot dir");
        fs::create_dir_all(dir.join("notes")).expect("notes dir");
        fs::write(dir.join(".hreader/internal.html"), "").expect("write dot");
        fs::write(dir.join("b.html"), "").expect("write b");
        fs::write(dir.join("a.htm"), "").expect("write a");
        fs::write(dir.join("ignore.txt"), "").expect("write txt");
        fs::write(dir.join("notes/sub.html"), "").expect("write sub");

        let found = list_html_files(&dir);
        assert_eq!(found, vec!["a.htm", "b.html", "notes/sub.html"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_workspace_tree_builds_nested_sorted_tree_and_skips_hidden() {
        let dir = temp_ws("tree");
        fs::create_dir_all(dir.join("system/paper/deep")).expect("deep dir");
        fs::create_dir_all(dir.join("empty_folder")).expect("empty dir");
        fs::create_dir_all(dir.join(".hidden_dir")).expect("hidden dir");
        fs::create_dir_all(dir.join("node_modules/pkg")).expect("node_modules dir");
        fs::write(dir.join("root.html"), "").expect("root html");
        fs::write(dir.join("readme.txt"), "").expect("txt ignored");
        fs::write(dir.join("system/paper/deep/note.html"), "").expect("deep note");
        fs::write(dir.join("node_modules/pkg/skip.html"), "").expect("skip nm");

        let tree = scan_workspace_tree(&dir);
        let names: Vec<&str> = tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["empty_folder", "system", "root.html"]);
        assert_eq!(tree[0].kind, TreeEntryKind::Dir);
        assert_eq!(tree[1].children[0].name, "paper");
        assert_eq!(tree[1].children[0].children[0].name, "deep");
        assert_eq!(
            tree[1].children[0].children[0].children[0].path,
            "system/paper/deep/note.html"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_custom_themes_parses_valid_json_and_sanitizes_vars() {
        let root = temp_ws("themes");
        let user_dir = root.join("user-themes");
        let ws = root.join("vault");
        fs::create_dir_all(&ws).expect("vault dir");
        ensure_user_themes_dir_in(&user_dir).expect("ensure user themes");
        assert!(user_dir.join("nord-example.json").is_file());

        let ws_themes = ws.join(".hreader/themes");
        fs::create_dir_all(&ws_themes).expect("ws themes");
        fs::write(
            ws_themes.join("custom.json"),
            r##"{
              "id": "forest/bad",
              "name": "Forest",
              "base": "paper",
              "vars": {
                "--hr-accent": "#2d6a4f",
                "bad-key": "#fff",
                "--inject": "red; } </style>"
              },
              "css": "body { opacity: 1; }</style><script>alert(1)</script>"
            }"##,
        )
        .expect("write custom json");
        fs::write(ws_themes.join("broken.json"), "{ not valid json").expect("write broken");

        let themes = load_custom_themes(Some(&user_dir), &ws);
        assert_eq!(themes.len(), 2);
        assert_eq!(themes[0].id, "nord-slate");
        assert_eq!(themes[0].base, "dark");
        let forest = &themes[1];
        assert_eq!(forest.id, "forestbad");
        assert_eq!(forest.base, "paper");
        assert_eq!(
            forest.vars,
            vec![("--hr-accent".to_string(), "#2d6a4f".to_string())]
        );
        assert!(!forest.css.to_ascii_lowercase().contains("</style"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn init_script_embeds_typora_workbench_markers_and_handlers() {
        let ctx = WorkbenchContext {
            workspace: "/tmp/ws".to_string(),
            doc_id: "demo.html".to_string(),
            files: vec!["demo.html".to_string()],
            tree: vec![TreeNode {
                name: "demo.html".to_string(),
                path: "demo.html".to_string(),
                kind: TreeEntryKind::File,
                children: Vec::new(),
            }],
            custom_themes: Vec::new(),
            is_macos: true,
        };
        let script = init_script(&ctx);
        assert!(script.contains("window.__HR_DESKTOP_CTX__"));
        assert!(script.contains("demo.html"));
        assert!(script.contains("__hrMenuAction"));
        assert!(script.contains("hrd-source-pane"));
        assert!(script.contains("hrd-block-gutter"));
        assert!(script.contains("hrd-notes-open"));
        assert!(script.contains("hrd-sb-hotzone"));
        assert!(script.contains("hrd-overlay-title"));
        assert!(script.contains("hrd-set-barstyle"));
        assert!(script.contains("bottomBarStyle"));
        assert!(script.contains("hrd-empty-state"));
        assert!(script.contains("renderEmptyState"));
        assert!(script.contains("isEmptyMode"));
        assert!(script.contains("data-tauri-drag-region"));
        assert!(script.contains("/reauth"));
        assert!(script.contains("window.__hrDesktopSync = (nextCtx) => {\n    if (checkUnauthorizedRecovery()) return;\n    setupWorkbench();"));
        assert!(sync_payload_js(&ctx).contains("window.__hrDesktopSync"));
    }
}
