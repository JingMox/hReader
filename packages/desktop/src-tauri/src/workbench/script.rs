//! 注入 Webview 的工作台上下文序列化与脚本拼接。

use serde::Serialize;

use super::themes::CustomTheme;
use super::tree::TreeNode;

const WORKBENCH_CSS: &str = include_str!("../../../webview/workbench.css");

// 拼接顺序是确定性的：基础状态与常量先行，随后按依赖顺序注册各功能模块，最后装配入口与快捷键。
const WORKBENCH_JS_MODULES: &[&str] = &[
    include_str!("../../../webview/state.js"),
    include_str!("../../../webview/components.js"),
    include_str!("../../../webview/theme.js"),
    include_str!("../../../webview/tree.js"),
    include_str!("../../../webview/editor-dom.js"),
    include_str!("../../../webview/editor-ops.js"),
    include_str!("../../../webview/source-view.js"),
    include_str!("../../../webview/overlay.js"),
    include_str!("../../../webview/modals.js"),
    include_str!("../../../webview/sidebar.js"),
    include_str!("../../../webview/statusbar.js"),
    include_str!("../../../webview/menu-shortcuts.js"),
    include_str!("../../../webview/bootstrap.js"),
];

/// 注入前端的工作台上下文（通过 `initialization_script` 与 `on_page_load` 同步到 `window.__HR_DESKTOP_CTX__`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchContext {
    pub workspace: String,
    pub doc_id: String,
    pub files: Vec<String>,
    pub tree: Vec<TreeNode>,
    pub custom_themes: Vec<CustomTheme>,
    pub is_macos: bool,
}

fn serialize_context(ctx: &WorkbenchContext) -> String {
    serde_json::to_string(ctx).expect("WorkbenchContext 序列化不应失败")
}

/// 序列化实时工作台上下文，用于在 `on_page_load` 时刷新前端文档与工作区状态。
pub fn sync_payload_js(ctx: &WorkbenchContext) -> String {
    let payload = serialize_context(ctx);
    format!("window.__hrDesktopSync && window.__hrDesktopSync({payload});")
}

/// 生成注入到 Webview 窗口的完整初始化脚本。
pub fn init_script(ctx: &WorkbenchContext) -> String {
    let payload = serialize_context(ctx);
    let css_literal = serde_json::to_string(WORKBENCH_CSS).expect("CSS 字符串序列化不应失败");

    let mut script = String::with_capacity(
        payload.len()
            + css_literal.len()
            + WORKBENCH_JS_MODULES.iter().map(|m| m.len()).sum::<usize>()
            + 512,
    );
    script.push_str("window.__HR_DESKTOP_CTX__ = ");
    script.push_str(&payload);
    script.push_str(";\n(() => {\n  \"use strict\";\n  if (window.__HR_DESKTOP_INSTALLED__) return;\n  window.__HR_DESKTOP_INSTALLED__ = true;\n  window.__hrd = { css: ");
    script.push_str(&css_literal);
    script.push_str(" };\n");
    for module in WORKBENCH_JS_MODULES {
        script.push_str("  {\n");
        script.push_str(module);
        if !module.ends_with('\n') {
            script.push('\n');
        }
        script.push_str("  }\n");
    }
    script.push_str("  delete window.__hrd;\n})();\n");
    script
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::TreeEntryKind;

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
            custom_themes: vec![CustomTheme {
                id: "nord".to_string(),
                name: "Nord".to_string(),
                base: "dark".to_string(),
                vars: vec![("--hr-accent".to_string(), "#88c0d0".to_string())],
                css: String::new(),
            }],
            is_macos: true,
        };
        let script = init_script(&ctx);
        assert!(script.contains("window.__HR_DESKTOP_CTX__"));
        assert!(script.contains("\"docId\":\"demo.html\""));
        assert!(script.contains("\"kind\":\"file\""));
        assert!(script.contains("\"vars\":{\"--hr-accent\":\"#88c0d0\"}"));
        assert!(script.contains("\"isMacos\":true"));
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
        assert!(script.contains(
            "window.__hrDesktopSync = (nextCtx) => {\n  if (checkUnauthorizedRecovery()) return;\n  setupWorkbench();"
        ));
        assert!(sync_payload_js(&ctx).contains("window.__hrDesktopSync"));
    }
}
