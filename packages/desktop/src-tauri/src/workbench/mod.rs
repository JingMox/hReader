//! 桌面阅读与笔记工作台：目录树、自定义主题、HTML 模板与 Webview 注入脚本。
//! 本模块保持纯 Rust（不碰 `tauri`），遵守桌面壳静态层分界（`check.sh`）。

mod script;
mod templates;
mod themes;
mod tree;

pub use script::{init_script, sync_payload_js, DocError, WorkbenchContext};
pub use templates::{escape_html, starter_html, welcome_html};
pub use themes::{ensure_user_themes_dir_in, load_custom_themes, user_themes_dir, CustomTheme};
pub use tree::{is_html_file, list_html_files, scan_workspace_tree, TreeEntryKind, TreeNode};
