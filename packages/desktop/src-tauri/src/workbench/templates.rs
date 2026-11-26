//! 新建空白文档与欢迎引导页的 HTML 模板装配。

const STARTER_TEMPLATE: &str = include_str!("../../../templates/starter.html");
const WELCOME_TEMPLATE: &str = include_str!("../../../templates/welcome.html");

/// 生成供 HTML 标签或正文中使用的转义文本。
pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 新建空白排版文档模板（已带规范 `data-hr-id`，可立即在阅读器和 CLI 中使用）。
pub fn starter_html(title: &str) -> String {
    let safe_title = escape_html(if title.trim().is_empty() {
        "未命名文档"
    } else {
        title.trim()
    });
    STARTER_TEMPLATE.replace("{{TITLE}}", &safe_title)
}

/// 首次无工作区文档打开时的欢迎引导页（带核心能力与真实组件演示）。
pub fn welcome_html() -> &'static str {
    WELCOME_TEMPLATE
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
