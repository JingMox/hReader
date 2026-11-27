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
    include_str!("../../../webview/immersive.js"),
    include_str!("../../../webview/menu-shortcuts.js"),
    include_str!("../../../webview/bootstrap.js"),
];

/// 单份文档打开失败：只挡这一份，文件树照常可用。
/// `hr serve` 起不来的原因由 core/CLI 决定（分类、拒绝码），壳只做搬运。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocError {
    pub doc_id: String,
    pub message: String,
}

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
    /// `Some` 时当前没有打开成功的文档：前端在正文区渲染"这份文档打不开"。
    pub doc_error: Option<DocError>,
    /// 设置里的默认模板 id：`None` = 新建文档默认走空白文档。
    pub default_template: Option<String>,
    /// 原生桥导航（`hr-desktop.local`）的会话令牌：页面 JS 必须回带它壳才认账。
    /// **只经 `sync_payload_js` 投递**（`win.eval` 只跑主 frame）；`init_script`
    /// 里该字段恒为空串——见那里的注释。
    pub bridge_token: String,
}

fn serialize_context(ctx: &WorkbenchContext) -> String {
    // payload 会原样落进 HTML 的 <script> 槽位：主题名、docError 文案、文件名都可控，
    // 里面的 `</script>` 会提前终止初始化脚本变成注入。JSON 字符串里 `\/` 与 `/` 等价。
    serde_json::to_string(ctx)
        .expect("WorkbenchContext 序列化不应失败")
        .replace("</", "<\\/")
}

/// 序列化实时工作台上下文，用于在 `on_page_load` 时刷新前端文档与工作区状态。
pub fn sync_payload_js(ctx: &WorkbenchContext) -> String {
    let payload = serialize_context(ctx);
    format!("window.__hrDesktopSync && window.__hrDesktopSync({payload});")
}

/// 生成注入到 Webview 窗口的完整初始化脚本。
///
/// **桥令牌绝不进 init 脚本**：`initialization_script` 在 WebView2（Windows）会注入
/// 所有 frame——外来文档的沙箱 iframe 也在其列（wry `for_main_frame_only` 在 Windows
/// 无效）。拿到令牌的外来页面就能伪造 `hr-desktop.local/bridge?t=…` 触发原生动作。
/// 这里把令牌置空，真值只经 `sync_payload_js` 投递（`win.eval` 只跑主 frame）。
/// macOS 上 WKUserScript 本就 for_main_frame_only，此举是跨平台一致的最小权限。
pub fn init_script(ctx: &WorkbenchContext) -> String {
    let mut sanitized = ctx.clone();
    sanitized.bridge_token = String::new();
    let payload = serialize_context(&sanitized);
    let css_literal = serde_json::to_string(WORKBENCH_CSS)
        .expect("CSS 字符串序列化不应失败")
        .replace("</", "<\\/");

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
                assets: Vec::new(),
                title: None,
                entry: None,
                hidden: false,
            }],
            custom_themes: vec![CustomTheme {
                id: "nord".to_string(),
                name: "Nord".to_string(),
                base: "dark".to_string(),
                vars: vec![("--hr-accent".to_string(), "#88c0d0".to_string())],
                css: String::new(),
            }],
            is_macos: true,
            default_template: None,
            bridge_token: "t".to_string(),
            doc_error: None,
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

    /// 注入脚本被原样塞进 HTML 的 script 槽位：payload 里任何 `</` 序列（主题名、
    /// docError 文案、文件路径都可能带）都必须写成 `<\/`，否则 `</script>` 直接截断
    /// 初始化脚本，攻击者控制的主题 JSON 就能在 webview 里注入任意代码。
    #[test]
    fn payloads_never_emit_a_literal_close_tag_sequence() {
        let ctx = WorkbenchContext {
            workspace: "/tmp/ws".to_string(),
            doc_id: String::new(),
            files: vec!["a.html".to_string()],
            tree: vec![],
            custom_themes: vec![CustomTheme {
                id: "evil".to_string(),
                name: "</SCRIPT><img src=x onerror=alert(1)>".to_string(),
                base: "light".to_string(),
                vars: vec![("--x".to_string(), "</script>".to_string())],
                css: "a{}</script><script>alert(2)</script>".to_string(),
            }],
            is_macos: true,
            default_template: None,
            bridge_token: "t".to_string(),
            doc_error: Some(DocError {
                doc_id: "bad.html".to_string(),
                message: "</script><script>alert(3)</script>".to_string(),
            }),
        };
        for js in [init_script(&ctx), sync_payload_js(&ctx)] {
            assert!(
                !js.to_ascii_lowercase().contains("</script"),
                "脚本里出现未转义的 </script：{js}"
            );
        }
    }

    /// 桥令牌只走主 frame 的 eval 同步：`init_script` 在 Windows/WebView2 会注入外来
    /// 文档 iframe，里面出现的任何令牌都能被外来脚本读去伪造桥导航。
    #[test]
    fn init_script_never_embeds_the_bridge_token() {
        let ctx = WorkbenchContext {
            workspace: "/tmp/ws".to_string(),
            doc_id: "demo.html".to_string(),
            files: vec!["demo.html".to_string()],
            tree: vec![],
            custom_themes: vec![],
            is_macos: true,
            default_template: None,
            bridge_token: "s3cr3t-bridge-token".to_string(),
            doc_error: None,
        };
        let script = init_script(&ctx);
        assert!(
            !script.contains("s3cr3t-bridge-token"),
            "init 脚本泄漏了桥令牌：外来 iframe 也能读到它"
        );
        assert!(
            script.contains("\"bridgeToken\":\"\""),
            "init 载荷里的桥令牌必须置空：{script}"
        );
        // 主 frame 的真值由 sync eval 投递（evaluate_script 不注入子 frame）。
        assert!(sync_payload_js(&ctx).contains("s3cr3t-bridge-token"));
    }

    /// 前端按 `ctx.bridgeToken`（camelCase）读令牌——`rename_all` 一旦断掉，
    /// 字段变成 `bridge_token`，页面拿到的就是 undefined，全部原生动作失灵。
    #[test]
    fn sync_payload_carries_the_token_under_the_js_field_name() {
        let ctx = WorkbenchContext {
            workspace: "/tmp/ws".to_string(),
            doc_id: "demo.html".to_string(),
            files: vec![],
            tree: vec![],
            custom_themes: vec![],
            is_macos: true,
            default_template: None,
            bridge_token: "tok-3".to_string(),
            doc_error: None,
        };
        let js = sync_payload_js(&ctx);
        assert!(
            js.contains("\"bridgeToken\":\"tok-3\""),
            "sync 载荷里的令牌字段名必须是 bridgeToken：{js}"
        );
        assert!(
            !js.contains("bridge_token"),
            "snake_case 字段名会饿死页面端：{js}"
        );
    }

    #[test]
    fn doc_error_reaches_the_frontend_as_camel_case_payload() {
        let ctx = WorkbenchContext {
            workspace: "/tmp/ws".to_string(),
            doc_id: String::new(),
            files: vec!["bad.html".to_string()],
            tree: vec![],
            custom_themes: vec![],
            is_macos: true,
            default_template: None,
            bridge_token: "t".to_string(),
            doc_error: Some(DocError {
                doc_id: "bad.html".to_string(),
                message: "hr serve 拒绝了这份文档：invalid_document".to_string(),
            }),
        };
        let script = init_script(&ctx);
        assert!(script.contains(
            "\"docError\":{\"docId\":\"bad.html\",\"message\":\"hr serve 拒绝了这份文档：invalid_document\"}"
        ));
        // 前端按 docError 渲染正文区错误提示（sidebar.js 的空状态分支）。
        assert!(script.contains("docError"));
    }
}
