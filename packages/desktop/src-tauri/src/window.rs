//! 平台壳：创建窗口、原生菜单栏、前端/本地桥接与全局快捷键；装配逻辑在 `connect`。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::webview::PageLoadEvent;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::shortcut::{self, Accel, Modifier};
use crate::signals;
use crate::supervisor::{self, Daemon};
use crate::{daemon_file, url_build, workbench, Reaper};

pub enum LaunchTarget {
    Session(crate::Session),
    Empty {
        workspace: PathBuf,
        cli: PathBuf,
    },
    /// 首个文档拉不起 `hr serve`：工作区照开（文件树可用），正文区给这份文档的失败原因。
    DocError {
        workspace: PathBuf,
        cli: PathBuf,
        doc_id: String,
        message: String,
    },
}

struct DesktopState {
    reaper: Option<Reaper>,
    port: Option<u16>,
    token: Option<String>,
    reauth_stage: u8,
    workspace: PathBuf,
    doc_id: String,
    cli: PathBuf,
    /// `hr-desktop.local` 桥导航的会话令牌：页面 JS 必须回带它壳才执行原生动作。
    bridge_token: String,
    /// 当前这份文档为什么打不开；`None` = 没有文档级失败。
    doc_error: Option<workbench::DocError>,
    /// 外来 iframe 的外部导航门栏：webview 经 `/doc-state` 桥同步；`None` = 非外来壳。
    doc_gate: Option<DocGate>,
}

impl DesktopState {
    fn context(&self) -> workbench::WorkbenchContext {
        workbench::WorkbenchContext {
            workspace: self.workspace.to_string_lossy().into_owned(),
            doc_id: self.doc_id.clone(),
            files: workbench::list_html_files(&self.workspace),
            tree: workbench::scan_workspace_tree(&self.workspace),
            custom_themes: workbench::load_custom_themes(
                workbench::user_themes_dir().as_deref(),
                &self.workspace,
            ),
            is_macos: cfg!(target_os = "macos"),
            doc_error: self.doc_error.clone(),
            bridge_token: self.bridge_token.clone(),
        }
    }

    /// 文档级失败的工作台状态：没有打开的文档，但工作区文件树照常可用，点其他文件即可恢复。
    /// 不动 `reaper`/`port`/`token`——daemon 死没死由调用点决定，这里只管"该显示什么"。
    fn mark_doc_error(&mut self, workspace: PathBuf, doc_id: &str, message: String) {
        self.workspace = workspace;
        self.doc_id = String::new();
        self.reauth_stage = 0;
        self.doc_error = Some(workbench::DocError {
            doc_id: doc_id.to_string(),
            message,
        });
        self.doc_gate = None;
    }
}

type SharedState = Arc<Mutex<DesktopState>>;

fn reap_shared(shared: &SharedState) {
    if let Ok(mut guard) = shared.lock() {
        if let Some(reaper) = guard.reaper.take() {
            reaper.reap();
        }
        guard.port = None;
        guard.token = None;
        guard.reauth_stage = 0;
    }
}

fn empty_page_url() -> tauri::Url {
    #[cfg(target_os = "windows")]
    let raw = "http://tauri.localhost/index.html";
    #[cfg(not(target_os = "windows"))]
    let raw = "tauri://localhost/index.html";
    raw.parse().expect("valid built-in empty page url")
}

pub fn run(target: LaunchTarget) -> i32 {
    let (initial_url, initial_title, state) = match target {
        LaunchTarget::Session(session) => {
            let url = session
                .reader_url
                .clone()
                .unwrap_or_else(|| session.url.clone());
            let Ok(parsed) = url.parse::<tauri::Url>() else {
                eprintln!("webview 地址不合法");
                session.daemon.reap();
                return 1;
            };
            let title = format!("{} — hReader", session.doc_id);
            let state = DesktopState {
                reaper: Some(session.daemon),
                port: Some(session.port),
                token: Some(session.token),
                reauth_stage: 0,
                workspace: session.workspace,
                doc_id: session.doc_id,
                cli: session.cli,
                bridge_token: mint_bridge_token(),
                doc_error: None,
                doc_gate: None,
            };
            (tauri::WebviewUrl::External(parsed), title, state)
        }
        LaunchTarget::Empty { workspace, cli } => {
            let state = DesktopState {
                reaper: None,
                port: None,
                token: None,
                reauth_stage: 0,
                workspace,
                doc_id: String::new(),
                cli,
                bridge_token: mint_bridge_token(),
                doc_error: None,
                doc_gate: None,
            };
            (
                tauri::WebviewUrl::App("index.html".into()),
                "hReader".to_string(),
                state,
            )
        }
        LaunchTarget::DocError {
            workspace,
            cli,
            doc_id,
            message,
        } => {
            let state = DesktopState {
                reaper: None,
                port: None,
                token: None,
                reauth_stage: 0,
                workspace,
                doc_id: String::new(),
                cli,
                bridge_token: mint_bridge_token(),
                doc_error: Some(workbench::DocError { doc_id, message }),
                doc_gate: None,
            };
            (
                tauri::WebviewUrl::App("index.html".into()),
                "hReader".to_string(),
                state,
            )
        }
    };
    let accels = match shortcut::default_accels() {
        Ok(accels) => accels,
        Err(error) => {
            eprintln!("accels.json 有误：{error:?}");
            if let Some(reaper) = state.reaper {
                reaper.reap();
            }
            return 1;
        }
    };

    let shared = Arc::new(Mutex::new(state));
    let initial_ctx = match shared.lock() {
        Ok(guard) => guard.context(),
        Err(poisoned) => poisoned.into_inner().context(),
    };

    let setup_shared = Arc::clone(&shared);
    let nav_shared = Arc::clone(&shared);
    let load_shared = Arc::clone(&shared);
    let menu_shared = Arc::clone(&shared);

    let outcome = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            let nav_app = app.handle().clone();
            let builder = tauri::WebviewWindowBuilder::new(app, "main", initial_url)
                .title(initial_title)
                .inner_size(1320.0, 860.0)
                .min_inner_size(820.0, 560.0)
                .initialization_script(workbench::init_script(&initial_ctx));
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let window = builder
                .on_page_load(move |win, payload| {
                    if matches!(payload.event(), PageLoadEvent::Finished) {
                        if let Ok(guard) = load_shared.lock() {
                            let _ = win.eval(workbench::sync_payload_js(&guard.context()));
                        }
                    }
                })
                .on_navigation(move |nav_url| {
                    match classify_navigation(nav_url) {
                        NavClass::Bridge => {
                            let expected = nav_shared
                                .lock()
                                .map(|guard| guard.bridge_token.clone())
                                .unwrap_or_default();
                            if bridge_authorized(nav_url, &expected) {
                                handle_bridge_navigation(&nav_app, &nav_shared, nav_url);
                            }
                            false
                        }
                        NavClass::Local => true,
                        NavClass::External => {
                            let action = nav_shared
                                .lock()
                                .map(|guard| external_nav_action(guard.doc_gate))
                                .unwrap_or(ExternalAction::Open);
                            match action {
                                // 联网开：框架内导航是全包语义的一部分，留在 iframe 里。
                                ExternalAction::Allow => true,
                                // 联网关的外来 iframe 自导航：连系统浏览器都不给开。
                                ExternalAction::Deny => false,
                                // 文档里的外链不能把整个工作台导航走：交给系统浏览器。
                                ExternalAction::Open => {
                                    open_external(nav_url);
                                    false
                                }
                            }
                        }
                        NavClass::Deny => false,
                    }
                })
                .build()?;
            let _ = window.set_focus();
            let focus_win = window.clone();
            let focus_shared = Arc::clone(&setup_shared);
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(true) = event {
                    if let Ok(guard) = focus_shared.lock() {
                        let _ = focus_win.eval(workbench::sync_payload_js(&guard.context()));
                    }
                }
            });

            app.on_menu_event(move |app_handle, event| {
                handle_menu_event(app_handle, &menu_shared, event.id().as_ref());
            });

            register(app.handle(), &accels)?;
            // 关窗口 ≠ 退出：SIGTERM/SIGINT 也必须走到收尸，否则壳拉起的 daemon 会漏下来占端口。
            signals::watch();
            let handle = app.handle().clone();
            let stop_shared = Arc::clone(&setup_shared);
            signals::on_stop(move || {
                reap_shared(&stop_shared);
                handle.exit(0);
            });
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match outcome {
        Ok(app) => app,
        Err(error) => {
            eprintln!("窗口起不来：{error}");
            reap_shared(&shared);
            return 1;
        }
    };
    let exit_shared = Arc::clone(&shared);
    app.run(move |_app, event| {
        if exits(&event) {
            reap_shared(&exit_shared);
        }
    });
    reap_shared(&shared);
    0
}

fn item(
    app: &tauri::AppHandle,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, id, label, true, accel)
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let about_meta = AboutMetadata {
        name: Some("hReader".to_string()),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        comments: Some("面向长文档写作与结构化排版的桌面阅读工作台".to_string()),
        ..Default::default()
    };

    let app_sub = SubmenuBuilder::new(app, "hReader")
        .about(Some(about_meta))
        .separator()
        .item(&item(app, "settings", "偏好设置…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_sub = SubmenuBuilder::new(app, "文件")
        .item(&item(app, "new-file", "新建文档…", Some("CmdOrCtrl+N"))?)
        .item(&item(
            app,
            "open-file",
            "快速切换文档…",
            Some("CmdOrCtrl+O"),
        )?)
        .item(&item(
            app,
            "pick-file",
            "从访达打开文档…",
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .item(&item(
            app,
            "pick-folder",
            "打开工作区文件夹…",
            Some("CmdOrCtrl+Alt+O"),
        )?)
        .separator()
        .item(&item(app, "save-doc", "立即保存", Some("CmdOrCtrl+S"))?)
        .separator()
        .item(&item(app, "export-pdf", "导出带书签 PDF", None)?)
        .item(&item(app, "export-png", "导出高清 PNG 长图", None)?)
        .item(&item(app, "export-html", "导出打印版 HTML", None)?)
        .item(&item(app, "print", "系统打印…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item(app, "reveal", "在访达中显示目录", None)?)
        .build()?;

    let edit_sub = SubmenuBuilder::new(app, "编辑")
        .item(&PredefinedMenuItem::undo(app, Some("撤销输入"))?)
        .item(&PredefinedMenuItem::redo(app, Some("重做输入"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(app, Some("复制"))?)
        .item(&PredefinedMenuItem::paste(app, Some("粘贴"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("全选"))?)
        .separator()
        .item(&item(
            app,
            "edit-block",
            "编辑当前块 HTML…",
            Some("CmdOrCtrl+E"),
        )?)
        .item(&item(
            app,
            "undo",
            "撤销文档快照",
            Some("CmdOrCtrl+Shift+Z"),
        )?)
        .build()?;

    let block_sub = SubmenuBuilder::new(app, "段落与组件")
        .item(&item(app, "tag:p", "转为正文段落 P", None)?)
        .item(&item(app, "tag:h1", "转为一级标题 H1", None)?)
        .item(&item(app, "tag:h2", "转为二级标题 H2", None)?)
        .item(&item(app, "tag:h3", "转为三级标题 H3", None)?)
        .item(&item(app, "tag:blockquote", "转为引用块 Quote", None)?)
        .separator()
        .item(&item(app, "insert-para", "下方插入段落", None)?)
        .item(&item(
            app,
            "insert-comp",
            "打开组件面板…",
            Some("CmdOrCtrl+Shift+K"),
        )?)
        .separator()
        .item(&item(app, "comp:h2", "二级标题 H2", None)?)
        .item(&item(app, "comp:h3", "三级标题 H3", None)?)
        .item(&item(
            app,
            "comp:kpi-bento",
            "KPI 指标卡阵 (kpi-bento)",
            None,
        )?)
        .item(&item(
            app,
            "comp:callout-insight",
            "洞察高亮块 (callout-insight)",
            None,
        )?)
        .item(&item(
            app,
            "comp:callout-warning",
            "风险提示块 (callout-warning)",
            None,
        )?)
        .item(&item(
            app,
            "comp:split-compare",
            "左右对比分栏 (split-compare)",
            None,
        )?)
        .item(&item(
            app,
            "comp:deep-dive",
            "深度推演折叠 (deep-dive)",
            None,
        )?)
        .item(&item(
            app,
            "comp:step-timeline",
            "步骤时间线 (step-timeline)",
            None,
        )?)
        .item(&item(
            app,
            "comp:diagram-stage",
            "图表舞台 (diagram-stage)",
            None,
        )?)
        .separator()
        .item(&item(app, "delete-block", "删除当前选中块", None)?)
        .build()?;

    let theme_sub = SubmenuBuilder::new(app, "主题")
        .item(&item(app, "ui:light", "纯净原生白（默认）", None)?)
        .item(&item(app, "ui:paper", "暖纸典藏 (Paper)", None)?)
        .item(&item(app, "ui:dark", "深色静谧 (Dark)", None)?)
        .separator()
        .item(&item(app, "open-themes-dir", "打开自定义主题目录…", None)?)
        .item(&item(app, "reload-themes", "重新加载主题配置", None)?)
        .separator()
        .item(&item(
            app,
            "theme:atelier-editorial",
            "写入默认视觉：Atelier Editorial",
            None,
        )?)
        .separator()
        .item(&item(app, "settings", "字号、行距与主题设置…", None)?)
        .build()?;

    let view_sub = SubmenuBuilder::new(app, "视图")
        .item(&item(
            app,
            "toggle-left",
            "显隐左侧边栏",
            Some("CmdOrCtrl+Shift+L"),
        )?)
        .item(&item(
            app,
            "toggle-right",
            "显隐右侧批注抽屉",
            Some("CmdOrCtrl+Shift+R"),
        )?)
        .item(&item(
            app,
            "toggle-source",
            "切换源码模式",
            Some("CmdOrCtrl+/"),
        )?)
        .item(&item(
            app,
            "toggle-focus",
            "专注模式",
            Some("CmdOrCtrl+Shift+F"),
        )?)
        .item(&item(
            app,
            "toggle-immersive",
            "沉浸模式",
            Some("CmdOrCtrl+Shift+I"),
        )?)
        .item(&item(
            app,
            "toggle-native-fullscreen",
            "进入全屏",
            Some(NATIVE_FULLSCREEN_ACCEL),
        )?)
        .separator()
        .item(&item(app, "reload", "刷新窗口视图", Some("CmdOrCtrl+R"))?)
        .build()?;

    let help_sub = SubmenuBuilder::new(app, "帮助")
        .item(&item(app, "welcome", "打开欢迎指南文档", None)?)
        .item(&item(app, "help", "快捷键与功能说明", None)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_sub, &file_sub, &edit_sub, &block_sub, &theme_sub, &view_sub, &help_sub,
        ])
        .build()
}

fn open_themes_dir(app: &tauri::AppHandle, shared: &SharedState) {
    let Some(dir) = workbench::user_themes_dir() else {
        toast(app, "无法定位用户主题目录 (~/.hreader/themes)", true);
        return;
    };
    if let Err(err) = workbench::ensure_user_themes_dir_in(&dir) {
        toast(app, &format!("初始化主题目录失败：{err}"), true);
        return;
    }
    reveal_path(&dir);
    if let (Some(win), Ok(guard)) = (app.get_webview_window("main"), shared.lock()) {
        let _ = win.eval(workbench::sync_payload_js(&guard.context()));
    }
    toast(app, "已打开自定义主题目录 (~/.hreader/themes)", false);
}

fn reload_themes(app: &tauri::AppHandle, shared: &SharedState) {
    if let (Some(win), Ok(guard)) = (app.get_webview_window("main"), shared.lock()) {
        let _ = win.eval(workbench::sync_payload_js(&guard.context()));
        toast(app, "已重新加载主题配置", false);
    }
}

/// 原生全屏的菜单键：macOS 沿用系统习惯 `^⌘F`，其他平台给 F11。
#[cfg(target_os = "macos")]
const NATIVE_FULLSCREEN_ACCEL: &str = "Ctrl+CmdOrCtrl+F";
#[cfg(not(target_os = "macos"))]
const NATIVE_FULLSCREEN_ACCEL: &str = "F11";

fn handle_menu_event(app: &tauri::AppHandle, shared: &SharedState, id: &str) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    match id {
        "toggle-native-fullscreen" => {
            let next = !win.is_fullscreen().unwrap_or(false);
            let _ = win.set_fullscreen(next);
        }
        "pick-file" => pick_file_async(app.clone(), Arc::clone(shared)),
        "pick-folder" => pick_folder_async(app.clone(), Arc::clone(shared)),
        "welcome" => open_welcome(app.clone(), Arc::clone(shared)),
        "reveal" => reveal_in_finder(shared, None),
        "open-themes-dir" => open_themes_dir(app, shared),
        "reload-themes" => reload_themes(app, shared),
        "export-pdf" => export_async(app.clone(), Arc::clone(shared), "pdf", None),
        "export-png" => export_async(app.clone(), Arc::clone(shared), "png", None),
        "export-html" => export_async(app.clone(), Arc::clone(shared), "html", None),
        "reload" => {
            if let Ok(guard) = shared.lock() {
                if let Some(port) = guard.port {
                    if !guard.doc_id.is_empty() {
                        if let Ok(target) = url_build::doc_reader_url(port, &guard.doc_id) {
                            if let Ok(parsed) = target.parse::<tauri::Url>() {
                                let _ = win.navigate(parsed);
                            }
                        }
                        return;
                    }
                }
                let _ = win.eval(workbench::sync_payload_js(&guard.context()));
            }
        }
        other => {
            if let Ok(encoded) = serde_json::to_string(other) {
                let _ = win.eval(format!(
                    "window.__hrMenuAction && window.__hrMenuAction({encoded});"
                ));
            }
        }
    }
}

/// `on_navigation` 的目标分类：工作台只许在 loopback/Tauri scheme 里动，外链交给浏览器，
/// 其余 scheme（`file:`/`javascript:`/`data:`…）一律拦截——文档内容本身不可信。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NavClass {
    /// daemon 页面与 Tauri app scheme：放行。
    Local,
    /// `hr-desktop.local` 原生桥：壳接管，永不真正导航。
    Bridge,
    /// http(s) 外链：交给系统浏览器。
    External,
    /// 其他一律拦截。
    Deny,
}

fn classify_navigation(url: &tauri::Url) -> NavClass {
    let host = url.host_str().unwrap_or_default();
    let is_loopback = matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1");
    match url.scheme() {
        "tauri" => NavClass::Local,
        "http" if host == "hr-desktop.local" => NavClass::Bridge,
        "http" | "https" if host == "hr-desktop.local" => NavClass::Deny,
        "http" if is_loopback || host == "tauri.localhost" => NavClass::Local,
        "https" if host == "tauri.localhost" => NavClass::Local,
        "http" | "https" => NavClass::External,
        _ => NavClass::Deny,
    }
}

/// 外来文档 iframe 的外部导航门栏：webview 经 `/doc-state` 桥同步的生效联网维。
/// `None` = 非外来壳或尚未上报——外链照旧交给系统浏览器。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DocGate {
    /// 生效的联网维：开 = 外部导航是全包语义的一部分，留在框架内；关 = 连系统浏览器都不给开。
    network: bool,
}

/// `NavClass::External` 的裁决：交给系统浏览器 / 留在框架内 / 直接拒绝。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExternalAction {
    Open,
    Allow,
    Deny,
}

/// 外来 iframe 自导航的闸门：联网是全包语义——开档时外部导航留在框架内，
/// 关档时连系统浏览器都不给开。非外来壳（None）照旧 Open。
fn external_nav_action(gate: Option<DocGate>) -> ExternalAction {
    match gate {
        Some(gate) if gate.network => ExternalAction::Allow,
        Some(_) => ExternalAction::Deny,
        None => ExternalAction::Open,
    }
}

/// `/doc-state` 桥的载荷：webview 上报当前文档是否外来壳与其生效联网维。
struct DocGateReport {
    doc: String,
    foreign: bool,
    network: bool,
}

fn parse_doc_gate(url: &tauri::Url) -> DocGateReport {
    DocGateReport {
        doc: query_param(url, "doc").unwrap_or_default(),
        foreign: query_param(url, "foreign").as_deref() == Some("1"),
        network: query_param(url, "net").as_deref() == Some("1"),
    }
}

/// 落闸只认当前文档：晚到的旧文档上报不许改新文档的裁决；`foreign=0` 归还门栏。
fn apply_doc_gate(current: &mut Option<DocGate>, report: &DocGateReport, current_doc: &str) {
    if report.doc != current_doc {
        return;
    }
    *current = if report.foreign {
        Some(DocGate {
            network: report.network,
        })
    } else {
        None
    };
}

/// 桥 URL 必须回带 `?t=<bridgeToken>`：文档/外部页猜不到这个会话随机值，伪造不了原生动作。
fn bridge_authorized(url: &tauri::Url, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    query_param(url, "t").is_some_and(|token| token == expected)
}

/// RandomState 的实例种子每次随机：令牌无需密码学强度，只需页面读不到也猜不中。
fn mint_bridge_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(nanos);
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

/// 外链交给系统浏览器打开，而不是让 webview 离开工作台。
fn open_external(url: &tauri::Url) {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url.as_str()).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .spawn();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = Command::new("xdg-open").arg(url.as_str()).spawn();
    }
}

fn query_param(url: &tauri::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, val)| val.into_owned())
}

fn handle_bridge_navigation(app: &tauri::AppHandle, shared: &SharedState, url: &tauri::Url) {
    match url.path() {
        "/drag" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.start_dragging();
            }
        }
        "/toggle-maximize" => {
            if let Some(win) = app.get_webview_window("main") {
                if win.is_maximized().unwrap_or(false) {
                    let _ = win.unmaximize();
                } else {
                    let _ = win.maximize();
                }
            }
        }
        "/reauth" => handle_reauth(app, shared),
        "/doc-state" => {
            // webview 上报外来壳门栏：只认当前文档，foreign=0 即归还。
            if let Ok(mut guard) = shared.lock() {
                let report = parse_doc_gate(url);
                let current_doc = guard.doc_id.clone();
                apply_doc_gate(&mut guard.doc_gate, &report, &current_doc);
            }
        }
        "/open" => {
            if let Some(doc) = query_param(url, "doc") {
                open_doc_in_workspace(app.clone(), Arc::clone(shared), doc);
            }
        }
        "/new" => {
            let title = query_param(url, "title").unwrap_or_else(|| "未命名文档".to_string());
            let raw_file = query_param(url, "file").unwrap_or_default();
            create_new_doc(app.clone(), Arc::clone(shared), title, raw_file);
        }
        "/welcome" => open_welcome(app.clone(), Arc::clone(shared)),
        "/pick-file" => pick_file_async(app.clone(), Arc::clone(shared)),
        "/pick-folder" => pick_folder_async(app.clone(), Arc::clone(shared)),
        "/reveal" => reveal_in_finder(shared, query_param(url, "doc").as_deref()),
        "/open-themes-dir" => open_themes_dir(app, shared),
        "/reload-themes" => reload_themes(app, shared),
        "/export-pdf" => {
            export_async(
                app.clone(),
                Arc::clone(shared),
                "pdf",
                query_param(url, "doc"),
            );
        }
        "/export-png" => {
            export_async(
                app.clone(),
                Arc::clone(shared),
                "png",
                query_param(url, "doc"),
            );
        }
        "/export-html" => {
            export_async(
                app.clone(),
                Arc::clone(shared),
                "html",
                query_param(url, "doc"),
            );
        }
        _ => {}
    }
}

fn toast(app: &tauri::AppHandle, msg: &str, is_err: bool) {
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(encoded) = serde_json::to_string(msg) {
            let _ = win.eval(format!(
                "window.__hrDesktopToast && window.__hrDesktopToast({encoded}, {is_err});"
            ));
        }
    }
}

/// 文档级打开失败落到空工作台：文件树照常可用、正文区给出这份文档的原因，点其他文件即可恢复。
/// `hr serve` 起不来只挡这一份文档，不再让整个工作区失败。
fn show_doc_error(
    app: &tauri::AppHandle,
    shared: &SharedState,
    workspace: PathBuf,
    doc_id: &str,
    message: String,
) {
    let ctx = match shared.lock() {
        Ok(mut guard) => {
            guard.mark_doc_error(workspace, doc_id, message);
            guard.context()
        }
        Err(_) => return,
    };
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.navigate(empty_page_url());
        let _ = win.eval(workbench::sync_payload_js(&ctx));
    }
}

fn ensure_daemon_and_open(
    app: &tauri::AppHandle,
    shared: &SharedState,
    target_ws: PathBuf,
    doc_id: String,
) {
    // 工作区级失败：目录本身进不去，谈不上"这份文档"——提示后什么都不动。
    if !target_ws.is_dir() {
        toast(
            app,
            &format!("打开工作区失败：{} 不存在或不是目录", target_ws.display()),
            true,
        );
        return;
    }

    let fast_path = match shared.lock() {
        Ok(mut guard) => {
            if guard.workspace == target_ws {
                if let (Some(_), Some(port)) = (&guard.reaper, guard.port) {
                    guard.doc_id = doc_id.clone();
                    guard.doc_error = None;
                    guard.doc_gate = None;
                    Some(port)
                } else {
                    None
                }
            } else {
                None
            }
        }
        Err(_) => return,
    };

    if let Some(port) = fast_path {
        match url_build::doc_reader_url(port, &doc_id) {
            Ok(target) => {
                if let (Some(win), Ok(parsed)) = (app.get_webview_window("main"), target.parse()) {
                    let _ = win.navigate(parsed);
                }
            }
            // docId 不合法只挡这一份：daemon 还活着，不能误杀。
            Err(err) => show_doc_error(app, shared, target_ws, &doc_id, err.to_string()),
        }
        return;
    }

    let cli = match shared.lock() {
        Ok(guard) => guard.cli.clone(),
        Err(_) => return,
    };

    let Ok(home) = crate::default_home() else {
        toast(app, "无法定位桌面数据目录", true);
        return;
    };
    if fs::create_dir_all(&home).is_err() {
        toast(app, "无法创建桌面数据目录", true);
        return;
    }
    crate::save_last_workspace(&home, &target_ws);

    let had_daemon = match shared.lock() {
        Ok(guard) => guard.reaper.is_some(),
        Err(_) => false,
    };
    reap_shared(shared);
    let _ = fs::remove_file(daemon_file::daemon_file_in(&home));
    if had_daemon {
        thread::sleep(Duration::from_millis(120));
    }

    let app_dir = supervisor::default_app_dir();
    let new_daemon =
        match Daemon::spawn_with_app(&cli, &doc_id, &target_ws, &home, None, app_dir.as_deref()) {
            Ok(d) => d,
            Err(err) => {
                show_doc_error(app, shared, target_ws, &doc_id, err.to_string());
                return;
            }
        };
    let info = new_daemon.info().clone();
    let next_url = if app_dir.is_some() {
        url_build::reader_url(info.port, &info.token)
    } else {
        match url_build::bootstrap_url(info.port, &doc_id, &info.token) {
            Ok(u) => u,
            Err(err) => {
                drop(new_daemon);
                show_doc_error(
                    app,
                    shared,
                    target_ws,
                    &doc_id,
                    format!("无效文档路径：{err}"),
                );
                return;
            }
        }
    };

    if let Ok(mut guard) = shared.lock() {
        guard.reaper = Some(Reaper::new(new_daemon));
        guard.port = Some(info.port);
        guard.token = Some(info.token);
        guard.reauth_stage = 0;
        guard.doc_error = None;
        guard.doc_gate = None;
        guard.workspace = target_ws;
        guard.doc_id = doc_id;
    }

    if let (Some(win), Ok(parsed)) = (app.get_webview_window("main"), next_url.parse()) {
        let _ = win.navigate(parsed);
    }
}

fn handle_reauth(app: &tauri::AppHandle, shared: &SharedState) {
    let (stage, port, token, doc_id) = match shared.lock() {
        Ok(mut guard) => {
            if guard.reauth_stage >= 3 {
                return;
            }
            let stage = guard.reauth_stage;
            guard.reauth_stage += 1;
            let (Some(port), Some(token)) = (guard.port, guard.token.clone()) else {
                return;
            };
            (stage, port, token, guard.doc_id.clone())
        }
        Err(_) => return,
    };
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    match stage {
        0 | 2 => {
            let _ = win.eval("window.location.replace('/');");
        }
        1 => {
            let app_dir = supervisor::default_app_dir();
            let target = if app_dir.is_some() {
                url_build::reader_url(port, &token)
            } else {
                match url_build::bootstrap_url(port, &doc_id, &token) {
                    Ok(u) => u,
                    Err(_) => return,
                }
            };
            if let Ok(parsed) = target.parse::<tauri::Url>() {
                let _ = win.navigate(parsed);
            }
        }
        _ => {}
    }
}

fn open_doc_in_workspace(app: tauri::AppHandle, shared: SharedState, doc: String) {
    thread::spawn(move || {
        let target_ws = match shared.lock() {
            Ok(guard) => guard.workspace.clone(),
            Err(_) => return,
        };
        ensure_daemon_and_open(&app, &shared, target_ws, doc);
    });
}

fn safe_new_filename(raw: &str, workspace: &Path) -> String {
    let trimmed = raw.trim().replace(['/', '\\', '\0'], "-");
    // 文件树按点开头跳过：剥掉前导点，否则 `.hidden` 这类名字建出来用户永远看不到。
    let stem = trimmed.trim_start_matches('.');
    let stem = if stem.is_empty() {
        format!(
            "doc-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        )
    } else {
        stem.to_string()
    };
    let mut name = if stem.ends_with(".html") || stem.ends_with(".htm") {
        stem
    } else {
        format!("{stem}.html")
    };
    let mut counter = 1u32;
    let base = name.trim_end_matches(".html").to_string();
    while workspace.join(&name).exists() {
        name = format!("{base}-{counter}.html");
        counter += 1;
    }
    name
}

fn create_new_doc(app: tauri::AppHandle, shared: SharedState, title: String, raw_file: String) {
    thread::spawn(move || {
        let (workspace, cli) = match shared.lock() {
            Ok(guard) => (guard.workspace.clone(), guard.cli.clone()),
            Err(_) => return,
        };
        let doc_name = safe_new_filename(&raw_file, &workspace);
        let content = workbench::starter_html(&title);
        if let Err(err) = fs::write(workspace.join(&doc_name), content) {
            toast(&app, &format!("创建失败：{err}"), true);
            return;
        }
        let _ = supervisor::run_cli_task(
            &cli,
            &workspace,
            &["style", &doc_name, "--visual", "atelier-editorial"],
        );
        ensure_daemon_and_open(&app, &shared, workspace, doc_name);
    });
}

fn open_welcome(app: tauri::AppHandle, shared: SharedState) {
    thread::spawn(move || {
        let (workspace, cli) = match shared.lock() {
            Ok(guard) => (guard.workspace.clone(), guard.cli.clone()),
            Err(_) => return,
        };
        let path = workspace.join("welcome.html");
        if !path.exists() {
            if let Err(err) = fs::write(&path, workbench::welcome_html()) {
                toast(&app, &format!("写入欢迎文档失败：{err}"), true);
                return;
            }
            let _ = supervisor::run_cli_task(
                &cli,
                &workspace,
                &["style", "welcome.html", "--visual", "atelier-editorial"],
            );
        }
        ensure_daemon_and_open(&app, &shared, workspace, "welcome.html".to_string());
    });
}

fn reveal_path(target: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(target).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        if target.is_file() {
            cmd.arg("/select,").arg(target);
        } else {
            cmd.arg(target);
        }
        let _ = cmd.spawn();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let dir = if target.is_file() {
            target.parent().unwrap_or(target)
        } else {
            target
        };
        let _ = Command::new("xdg-open").arg(dir).spawn();
    }
}

/// reveal 的目标必须留在工作区里：`?doc=` 来自页面，绝对路径/`..` 会把它带出工作区
/// （顺带用 Finder 的存在性确认做了 oracle）。越界或不存在一律回落到工作区根。
fn resolve_reveal_target(workspace: &Path, doc: &str) -> PathBuf {
    if doc.is_empty() {
        return workspace.to_path_buf();
    }
    let rel = Path::new(doc);
    let escapes = rel.is_absolute()
        || rel.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        });
    if escapes {
        return workspace.to_path_buf();
    }
    let candidate = workspace.join(rel);
    if candidate.exists() {
        candidate
    } else {
        workspace.to_path_buf()
    }
}

fn reveal_in_finder(shared: &SharedState, doc_opt: Option<&str>) {
    let target = match shared.lock() {
        Ok(guard) => {
            let doc = doc_opt.unwrap_or(&guard.doc_id);
            resolve_reveal_target(&guard.workspace, doc)
        }
        Err(_) => return,
    };
    reveal_path(&target);
}

fn export_async(
    app: tauri::AppHandle,
    shared: SharedState,
    kind: &'static str,
    doc_opt: Option<String>,
) {
    thread::spawn(move || {
        let (workspace, cli, doc_id) = match shared.lock() {
            Ok(guard) => (
                guard.workspace.clone(),
                guard.cli.clone(),
                doc_opt.unwrap_or_else(|| guard.doc_id.clone()),
            ),
            Err(_) => return,
        };
        if doc_id.is_empty() {
            toast(&app, "请先新建或打开一个 HTML 文档", true);
            return;
        }
        let stem = Path::new(&doc_id)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output");
        let (subcmd, out_name) = match kind {
            "pdf" => ("pdf", format!("{stem}.pdf")),
            "png" => ("png", format!("{stem}.png")),
            _ => ("export", format!("{stem}-print.html")),
        };
        match supervisor::run_cli_task(
            &cli,
            &workspace,
            &[subcmd, &doc_id, "--out", &out_name, "--force"],
        ) {
            Ok(_) => {
                toast(&app, &format!("已导出 {out_name}"), false);
                reveal_path(&workspace.join(&out_name));
            }
            Err(err) => {
                toast(&app, &format!("导出失败：{err}"), true);
            }
        }
    });
}

fn dialog_path(picked: FilePath) -> Option<PathBuf> {
    picked.into_path().ok()
}

fn switch_workspace(
    app: &tauri::AppHandle,
    shared: &SharedState,
    new_ws: PathBuf,
    target_doc: Option<String>,
) {
    // 工作区级失败：目录本身不可用就不切过去，留在当前工作区。
    if !new_ws.is_dir() {
        toast(
            app,
            &format!("打开工作区失败：{} 不存在或不是目录", new_ws.display()),
            true,
        );
        return;
    }
    let doc_opt = target_doc.or_else(|| workbench::list_html_files(&new_ws).into_iter().next());
    if let Some(doc_id) = doc_opt {
        ensure_daemon_and_open(app, shared, new_ws, doc_id);
        return;
    }

    if let Ok(home) = crate::default_home() {
        crate::save_last_workspace(&home, &new_ws);
        reap_shared(shared);
        let _ = fs::remove_file(daemon_file::daemon_file_in(&home));
    } else {
        reap_shared(shared);
    }

    let ctx = match shared.lock() {
        Ok(mut guard) => {
            guard.reaper = None;
            guard.port = None;
            guard.token = None;
            guard.reauth_stage = 0;
            guard.workspace = new_ws;
            guard.doc_id = String::new();
            guard.doc_error = None;
            guard.context()
        }
        Err(_) => return,
    };

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.navigate(empty_page_url());
        let _ = win.eval(workbench::sync_payload_js(&ctx));
    }
}

fn pick_file_async(app: tauri::AppHandle, shared: SharedState) {
    thread::spawn(move || {
        let Some(chosen) = app
            .dialog()
            .file()
            .set_title("选择要打开的 HTML 文档")
            .add_filter("HTML 文档", &["html", "htm"])
            .blocking_pick_file()
            .and_then(dialog_path)
        else {
            return;
        };
        let current_ws = match shared.lock() {
            Ok(guard) => guard.workspace.clone(),
            Err(_) => return,
        };
        if let Ok(rel) = chosen.strip_prefix(&current_ws) {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if !rel_str.is_empty() {
                open_doc_in_workspace(app, shared, rel_str);
                return;
            }
        }
        if let (Some(parent), Some(name)) =
            (chosen.parent(), chosen.file_name().and_then(|n| n.to_str()))
        {
            switch_workspace(&app, &shared, parent.to_path_buf(), Some(name.to_string()));
        }
    });
}

fn pick_folder_async(app: tauri::AppHandle, shared: SharedState) {
    thread::spawn(move || {
        let Some(folder) = app
            .dialog()
            .file()
            .set_title("选择 hReader 文档工作区文件夹")
            .blocking_pick_folder()
            .and_then(dialog_path)
        else {
            return;
        };
        switch_workspace(&app, &shared, folder, None);
    });
}

/// 哪些运行时事件意味着"壳要走了"：关窗、退出请求、真退出。幂等收尸，多认几个事件不亏。
fn exits(event: &tauri::RunEvent) -> bool {
    match event {
        tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => true,
        tauri::RunEvent::WindowEvent { event, .. } => window_exits(event),
        _ => false,
    }
}

fn window_exits(event: &tauri::WindowEvent) -> bool {
    matches!(
        event,
        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
    )
}

/// 全局键只做一件事：把主窗口叫到前台（阅读器自己的按键一个都不抢）。
///
/// 注册失败必须是**启动失败**：吞掉 `Err` 就等于"快捷键默默不生效"，比崩更难查。
fn register(app: &tauri::AppHandle, accels: &[(String, Accel)]) -> Result<(), ShortcutError> {
    register_with(accels, &TauriRegistrar(app))
}

/// 注册动作抽成 trait：真实现要一个活着的应用，失败分支只能靠假实现才测得到。
trait Registrar {
    fn register(&self, shortcuts: &[Shortcut]) -> Result<(), String>;
}

struct TauriRegistrar<'a>(&'a tauri::AppHandle);

impl Registrar for TauriRegistrar<'_> {
    fn register(&self, shortcuts: &[Shortcut]) -> Result<(), String> {
        self.0
            .global_shortcut()
            .on_shortcuts(shortcuts.to_vec(), |app, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            })
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug)]
pub(crate) enum ShortcutError {
    /// 配了却映射不到 `tauri_plugin_global_shortcut` 的 `Code`：配错了就得说，不许跳过。
    Unmappable(String),
    /// 系统拒绝注册（键被别的应用占着、或两个别名撞了同一个键）。
    Rejected(String),
}

impl std::fmt::Display for ShortcutError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unmappable(code) => write!(formatter, "全局快捷键 {code} 无法映射到系统按键"),
            Self::Rejected(detail) => write!(formatter, "全局快捷键注册被系统拒绝：{detail}"),
        }
    }
}

impl std::error::Error for ShortcutError {}

fn register_with(
    accels: &[(String, Accel)],
    registrar: &dyn Registrar,
) -> Result<(), ShortcutError> {
    let mut shortcuts = Vec::new();
    for (_, accel) in accels {
        shortcuts
            .push(shortcut_of(accel).ok_or_else(|| ShortcutError::Unmappable(accel.code.clone()))?);
    }
    if shortcuts.is_empty() {
        return Ok(());
    }
    registrar
        .register(&shortcuts)
        .map_err(ShortcutError::Rejected)
}

fn shortcut_of(accel: &Accel) -> Option<Shortcut> {
    let mut modifiers = Modifiers::empty();
    for modifier in &accel.modifiers {
        modifiers |= match modifier {
            Modifier::CommandOrCtrl if cfg!(target_os = "macos") => Modifiers::SUPER,
            Modifier::CommandOrCtrl | Modifier::Ctrl => Modifiers::CONTROL,
            Modifier::Alt => Modifiers::ALT,
            Modifier::Shift => Modifiers::SHIFT,
        };
    }
    let code = Code::from_str(&code_name(&accel.code)).ok()?;
    Some(Shortcut::new(Some(modifiers), code))
}

/// `accels.json` 写 `H`/`1` 这种短名（人写的），`Code` 要 `KeyH`/`Digit1`。
fn code_name(raw: &str) -> String {
    let mut chars = raw.chars();
    match (chars.next(), chars.next()) {
        (Some(single), None) if single.is_ascii_alphabetic() => {
            format!("Key{}", single.to_ascii_uppercase())
        }
        (Some(single), None) if single.is_ascii_digit() => format!("Digit{single}"),
        _ => raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeRegistrar {
        reject: bool,
    }

    impl Registrar for FakeRegistrar {
        fn register(&self, _shortcuts: &[Shortcut]) -> Result<(), String> {
            if self.reject {
                Err("这个键被别的应用占着".to_string())
            } else {
                Ok(())
            }
        }
    }

    fn accels() -> Vec<(String, Accel)> {
        shortcut::accels_from_json("{\"showWindow\":\"CmdOrCtrl+Shift+H\"}").expect("合法配置")
    }

    #[test]
    fn register_failure_bubbles_up_as_a_startup_failure() {
        let error = register_with(&accels(), &FakeRegistrar { reject: true })
            .expect_err("注册失败的 Err 必须冒泡，不许 let _ =");
        assert!(matches!(error, ShortcutError::Rejected(_)), "{error:?}");
    }

    #[test]
    fn unmappable_key_is_an_error_not_a_silent_skip() {
        let broken = [(
            "showWindow".to_string(),
            Accel {
                modifiers: vec![Modifier::Ctrl],
                code: "NoSuchKeyName".to_string(),
            },
        )];
        let error = register_with(&broken, &FakeRegistrar { reject: false })
            .expect_err("映射不到系统按键也是启动失败");
        assert!(
            matches!(&error, ShortcutError::Unmappable(code) if code == "NoSuchKeyName"),
            "{error:?}"
        );
    }

    #[test]
    fn ok_path_registers_every_accel() {
        assert!(register_with(&accels(), &FakeRegistrar { reject: false }).is_ok());
    }

    #[test]
    fn gui_exit_events_all_count_as_exits() {
        assert!(exits(&tauri::RunEvent::Exit));
        assert!(!exits(&tauri::RunEvent::Ready));
        assert!(window_exits(&tauri::WindowEvent::Destroyed));
        assert!(!window_exits(&tauri::WindowEvent::Focused(true)));
    }

    #[test]
    fn navigation_targets_are_classified_by_scheme_and_host() {
        use tauri::Url;
        let nav = |raw: &str| classify_navigation(&Url::parse(raw).expect("url"));
        assert_eq!(nav("http://127.0.0.1:8123/index.html"), NavClass::Local);
        assert_eq!(nav("http://localhost:8123/s/a.html"), NavClass::Local);
        assert_eq!(nav("http://[::1]:8123/x"), NavClass::Local);
        assert_eq!(nav("tauri://localhost/index.html"), NavClass::Local);
        assert_eq!(nav("http://tauri.localhost/index.html"), NavClass::Local);
        assert_eq!(nav("http://hr-desktop.local/bridge"), NavClass::Bridge);
        assert_eq!(nav("https://hr-desktop.local/x"), NavClass::Deny);
        assert_eq!(nav("http://example.com/"), NavClass::External);
        assert_eq!(nav("https://attacker.example/pwn"), NavClass::External);
        assert_eq!(nav("file:///etc/passwd"), NavClass::Deny);
        assert_eq!(nav("javascript:alert(1)"), NavClass::Deny);
        assert_eq!(nav("data:text/html,<h1>x</h1>"), NavClass::Deny);
        assert_eq!(nav("about:blank"), NavClass::Deny);
    }

    #[test]
    fn reader_urls_stay_local_so_foreign_doc_frames_are_untouched() {
        use tauri::Url;
        let nav = |raw: &str| classify_navigation(&Url::parse(raw).expect("url"));
        // `/s/<docId>` 沙箱 iframe（含 `?t=` 文档令牌与 `?r=` 重载标记）必须放行：
        // wry 的 on_navigation 对子帧同样触发（wkwebview/navigation.rs 的
        // navigation_policy 不查 targetFrame.isMainFrame），loopback 落 Local 才不误伤。
        assert_eq!(nav("http://127.0.0.1:8123/s/report.html"), NavClass::Local);
        assert_eq!(
            nav("http://127.0.0.1:8123/s/report.html?t=abc123"),
            NavClass::Local
        );
        assert_eq!(
            nav("http://localhost:8123/s/report.html?r=n3"),
            NavClass::Local
        );
        // `/api/*` 与 SSE 本是子资源请求不进导航闸；真走到这里（误开顶层）也按 Local 放行。
        assert_eq!(nav("http://127.0.0.1:8123/api/doc/x/info"), NavClass::Local);
        assert_eq!(nav("http://127.0.0.1:8123/api/events"), NavClass::Local);
        // 外来文档里的外链进 External——交给系统浏览器、webview 内导航取消，
        // 这对外来文档同样成立：外链绝不借 loopback 的壳加载。
        assert_eq!(nav("https://phish.example/?next=/s/x"), NavClass::External);
    }

    #[test]
    fn bridge_urls_require_the_session_token() {
        use tauri::Url;
        let url = |q: &str| Url::parse(&format!("http://hr-desktop.local/{q}")).expect("url");
        assert!(bridge_authorized(&url("bridge?t=secret&x=1"), "secret"));
        assert!(!bridge_authorized(&url("bridge?t=other"), "secret"));
        assert!(!bridge_authorized(&url("bridge"), "secret"));
        assert!(!bridge_authorized(&url("bridge?t="), "secret"));
        // 令牌本身不能是空串，否则 `?t=` 也能对上。
        assert!(!bridge_authorized(&url("bridge?t="), ""));
        let a = mint_bridge_token();
        let b = mint_bridge_token();
        assert!(!a.is_empty() && a != b, "桥令牌必须随机且不复用");
    }

    /// 对抗面：导航分类的等价形态——大小写归一、尾点/缩写/非标准 loopback、
    /// 伪协议族。任何漏网都只有两种结局：漏进 Local（外来页借 loopback 加载）或
    /// 漏进 Bridge（伪造原生动作）。
    #[test]
    fn navigation_edge_forms_cannot_smuggle_local_or_bridge() {
        use tauri::Url;
        let nav = |raw: &str| classify_navigation(&Url::parse(raw).expect("url"));
        // 归一化后的等价形态仍是本来的类（scheme/host 大小写不挡路）。
        assert_eq!(nav("HTTP://127.0.0.1:8123/x"), NavClass::Local);
        assert_eq!(nav("http://LOCALHOST:8123/x"), NavClass::Local);
        assert_eq!(nav("TaUrI://localhost/x"), NavClass::Local);
        assert_eq!(nav("HTTP://HR-DESKTOP.LOCAL/bridge"), NavClass::Bridge);
        // WHATWG IPv4 归一化：`127.1`/`2130706433`/`0x7f000001`/`127.0.0.1.`
        // 解析出来就是 127.0.0.1——判 Local 语义正确（它们确实是回环流量）。
        // 真正的认证边界在 daemon 的 Host 精确匹配：浏览器原样带 Host，
        // `127.1:port` 会被 core 的 hostAllowed 拒掉，导航放行 ≠ 请求通过。
        for raw in [
            "http://127.0.0.1.:8123/x",
            "http://127.1:8123/x",
            "http://2130706433:8123/x",
            "http://0x7f000001:8123/x",
        ] {
            assert_eq!(nav(raw), NavClass::Local, "{raw}");
        }
        // 尾点域名/0.0.0.0/userinfo/https 回环都不是 Local，也绝不该变成 Bridge：
        // 一律 External——交给系统浏览器和"当普通网站打开"语义一致，绝不内嵌。
        for raw in [
            "http://localhost.:8123/x",
            "http://0.0.0.0:8123/x",
            "http://hr-desktop.local.:8123/bridge",
            "https://127.0.0.1:8123/x",
            "http://127.0.0.1:8123@evil.example/",
        ] {
            assert_eq!(nav(raw), NavClass::External, "{raw}");
        }
        // 其余 scheme 一律 Deny：内容页没有合法理由触发它们。
        for raw in [
            "ws://127.0.0.1:8123/",
            "wss://127.0.0.1:8123/",
            "blob:http://127.0.0.1:8123/00000000-0000-0000-0000-000000000000",
            "view-source:http://127.0.0.1:8123/",
            "mailto:a@b.c",
            "tel:+123",
            "about:srcdoc",
            "ftp://127.0.0.1/x",
        ] {
            assert_eq!(nav(raw), NavClass::Deny, "{raw}");
        }
    }

    /// 令牌只经 sync eval 进主 frame 之后，每个原生动作路径都必须仍然
    /// 归 Bridge 类、带对令牌才放行——否则 webview JS 的新取令牌方式会把功能饿死。
    #[test]
    fn every_native_action_path_stays_bridge_and_token_gated() {
        use tauri::Url;
        const PATHS: &[&str] = &[
            "/drag",
            "/toggle-maximize",
            "/reauth",
            "/open",
            "/new",
            "/welcome",
            "/pick-file",
            "/pick-folder",
            "/reveal",
            "/open-themes-dir",
            "/reload-themes",
            "/export-pdf",
            "/export-png",
            "/export-html",
        ];
        for path in PATHS {
            let authed =
                Url::parse(&format!("http://hr-desktop.local{path}?doc=x&t=secret")).expect("url");
            assert_eq!(classify_navigation(&authed), NavClass::Bridge, "{path}");
            assert!(
                bridge_authorized(&authed, "secret"),
                "{path} 带对令牌必须放行"
            );
            let bare = Url::parse(&format!("http://hr-desktop.local{path}")).expect("url");
            assert!(!bridge_authorized(&bare, "secret"), "{path} 无令牌必须拒");
        }
    }

    #[test]
    fn bridge_auth_first_t_wins_and_param_name_is_case_sensitive() {
        use tauri::Url;
        let url = |q: &str| Url::parse(&format!("http://hr-desktop.local/{q}")).expect("url");
        // 首值生效：伪造者把真令牌塞在后面也救不了前面的假值（query_pairs 顺序读取）。
        assert!(!bridge_authorized(
            &url("bridge?t=forged&t=secret"),
            "secret"
        ));
        assert!(bridge_authorized(
            &url("bridge?t=secret&t=forged"),
            "secret"
        ));
        // 参数名大小写敏感：`?T=` 不是 `?t=`。
        assert!(!bridge_authorized(&url("bridge?T=secret"), "secret"));
        // 百分号编码按解码后值比较：`a%2Bb` 解回 `a+b`；字面 `+` 是空格。
        assert!(bridge_authorized(&url("bridge?t=a%2Bb"), "a+b"));
        assert!(!bridge_authorized(&url("bridge?t=a+b"), "a+b"));
    }

    #[test]
    fn reveal_never_leaves_the_workspace() {
        let ws = std::env::temp_dir().join(format!("hr-reveal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join("sub")).expect("建工作区");
        fs::write(ws.join("doc.html"), "<p>x</p>").expect("写文档");
        fs::write(ws.join("sub").join("doc.html"), "<p>x</p>").expect("写子文档");
        // 绝对路径与 .. 逃逸一律回落到工作区根。
        assert_eq!(resolve_reveal_target(&ws, "/etc/passwd"), ws);
        assert_eq!(resolve_reveal_target(&ws, "../outside.html"), ws);
        assert_eq!(resolve_reveal_target(&ws, "..\\..\\win"), ws);
        // 空串（DocError / 空态）回落工作区；工作区内存在的相对路径照常解析。
        assert_eq!(resolve_reveal_target(&ws, ""), ws);
        assert_eq!(resolve_reveal_target(&ws, "missing.html"), ws);
        assert_eq!(
            resolve_reveal_target(&ws, "sub/doc.html"),
            ws.join("sub/doc.html")
        );
        assert_eq!(resolve_reveal_target(&ws, "doc.html"), ws.join("doc.html"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn new_doc_names_never_create_hidden_files() {
        let ws = Path::new("/tmp/ws");
        for raw in ["..", ".", ".hidden", "..\\..\\x"] {
            let name = safe_new_filename(raw, ws);
            assert!(
                !name.starts_with('.'),
                "{raw:?} 生成了隐藏文件名 {name:?}——文件树按点开头跳过，用户永远看不到这份文件"
            );
        }
        assert_eq!(safe_new_filename(".hidden", ws), "hidden.html");
        assert_eq!(safe_new_filename("note", ws), "note.html");
        assert_eq!(safe_new_filename("note.html", ws), "note.html");
    }

    /// D2：外来 iframe 的外部导航裁决——联网关时连系统浏览器都不给开，
    /// 联网开时留在框架内（联网是全包语义）；非外来壳照旧交系统浏览器。
    #[test]
    fn foreign_doc_external_nav_is_gated_by_the_network_dimension() {
        assert_eq!(external_nav_action(None), ExternalAction::Open);
        assert_eq!(
            external_nav_action(Some(DocGate { network: true })),
            ExternalAction::Allow
        );
        assert_eq!(
            external_nav_action(Some(DocGate { network: false })),
            ExternalAction::Deny
        );
    }

    /// `/doc-state` 桥载荷的解析与落闸：只认当前文档，晚到的旧文档上报不改新文档的
    /// 裁决；`foreign=0`（外来壳离场）归还门栏。
    #[test]
    fn doc_state_reports_gate_only_the_current_doc() {
        use tauri::Url;
        let url =
            |q: &str| Url::parse(&format!("http://hr-desktop.local/doc-state?{q}")).expect("url");

        let mut gate = None;
        let report = parse_doc_gate(&url("doc=a.html&foreign=1&net=0&t=x"));
        apply_doc_gate(&mut gate, &report, "a.html");
        assert_eq!(gate, Some(DocGate { network: false }));

        let report = parse_doc_gate(&url("doc=a.html&foreign=1&net=1&t=x"));
        apply_doc_gate(&mut gate, &report, "a.html");
        assert_eq!(gate, Some(DocGate { network: true }));

        let report = parse_doc_gate(&url("doc=a.html&foreign=1&net=0&t=x"));
        apply_doc_gate(&mut gate, &report, "b.html");
        assert_eq!(gate, Some(DocGate { network: true }));

        let report = parse_doc_gate(&url("doc=b.html&foreign=0&net=0&t=x"));
        apply_doc_gate(&mut gate, &report, "b.html");
        assert_eq!(gate, None);
    }

    #[test]
    fn doc_error_keeps_the_workspace_and_clears_only_the_document() {
        let root = std::env::temp_dir().join(format!("hr-win-docerr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("建 workspace");
        fs::write(root.join("bad.html"), "<p>no article</p>").expect("写文档");

        let mut state = DesktopState {
            reaper: None,
            port: None,
            token: None,
            reauth_stage: 2,
            workspace: root.clone(),
            doc_id: "bad.html".to_string(),
            cli: PathBuf::from("/nonexistent/hr"),
            bridge_token: "test-token".to_string(),
            doc_error: None,
            doc_gate: None,
        };
        state.mark_doc_error(
            root.clone(),
            "bad.html",
            "hr serve 拒绝了这份文档：invalid_document".to_string(),
        );

        let ctx = state.context();
        assert!(
            ctx.doc_id.is_empty(),
            "文档级失败后没有打开中的文档，空状态页才渲染"
        );
        assert_eq!(ctx.files, vec!["bad.html"], "文件树必须照常工作");
        let error = ctx.doc_error.expect("docError 必须进工作台上下文");
        assert_eq!(error.doc_id, "bad.html");
        assert!(error.message.contains("invalid_document"), "{error:?}");
        assert_eq!(state.reauth_stage, 0);
        let _ = fs::remove_dir_all(&root);
    }
}
