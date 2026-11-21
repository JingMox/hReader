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
use crate::{daemon_file, ensure_doc_ready, url_build, workbench, Reaper};

pub enum LaunchTarget {
    Session(crate::Session),
    Empty { workspace: PathBuf, cli: PathBuf },
}

struct DesktopState {
    reaper: Option<Reaper>,
    port: Option<u16>,
    token: Option<String>,
    reauth_stage: u8,
    workspace: PathBuf,
    doc_id: String,
    cli: PathBuf,
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
        }
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
                    if nav_url.host_str() == Some("hr-desktop.local") {
                        handle_bridge_navigation(&nav_app, &nav_shared, nav_url);
                        return false;
                    }
                    true
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

fn handle_menu_event(app: &tauri::AppHandle, shared: &SharedState, id: &str) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    match id {
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

fn ensure_daemon_and_open(
    app: &tauri::AppHandle,
    shared: &SharedState,
    target_ws: PathBuf,
    doc_id: String,
) {
    let fast_path = match shared.lock() {
        Ok(mut guard) => {
            if guard.workspace == target_ws {
                if let (Some(_), Some(port)) = (&guard.reaper, guard.port) {
                    guard.doc_id = doc_id.clone();
                    Some((port, guard.cli.clone()))
                } else {
                    None
                }
            } else {
                None
            }
        }
        Err(_) => return,
    };

    if let Some((port, cli)) = fast_path {
        ensure_doc_ready(&cli, &target_ws, &doc_id);
        if let Ok(target) = url_build::doc_reader_url(port, &doc_id) {
            if let (Some(win), Ok(parsed)) = (app.get_webview_window("main"), target.parse()) {
                let _ = win.navigate(parsed);
            }
        }
        return;
    }

    let cli = match shared.lock() {
        Ok(guard) => guard.cli.clone(),
        Err(_) => return,
    };
    ensure_doc_ready(&cli, &target_ws, &doc_id);

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
                toast(app, &format!("打开工作区失败：{err}"), true);
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
                toast(app, &format!("无效文档路径：{err}"), true);
                return;
            }
        }
    };

    if let Ok(mut guard) = shared.lock() {
        guard.reaper = Some(Reaper::new(new_daemon));
        guard.port = Some(info.port);
        guard.token = Some(info.token);
        guard.reauth_stage = 0;
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
    let stem = if trimmed.is_empty() {
        format!(
            "doc-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        )
    } else {
        trimmed
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

fn reveal_in_finder(shared: &SharedState, doc_opt: Option<&str>) {
    let target = match shared.lock() {
        Ok(guard) => {
            let doc = doc_opt.unwrap_or(&guard.doc_id);
            if doc.is_empty() {
                guard.workspace.clone()
            } else {
                let candidate = guard.workspace.join(doc);
                if candidate.exists() {
                    candidate
                } else {
                    guard.workspace.clone()
                }
            }
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
    fn ac7_register_failure_bubbles_up_as_a_startup_failure() {
        let error = register_with(&accels(), &FakeRegistrar { reject: true })
            .expect_err("注册失败的 Err 必须冒泡，不许 let _ =");
        assert!(matches!(error, ShortcutError::Rejected(_)), "{error:?}");
    }

    #[test]
    fn ac7_unmappable_key_is_an_error_not_a_silent_skip() {
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
    fn ac7_ok_path_registers_every_accel() {
        assert!(register_with(&accels(), &FakeRegistrar { reject: false }).is_ok());
    }

    #[test]
    fn ac14_gui_exit_events_all_count_as_exits() {
        assert!(exits(&tauri::RunEvent::Exit));
        assert!(!exits(&tauri::RunEvent::Ready));
        assert!(window_exits(&tauri::WindowEvent::Destroyed));
        assert!(!window_exits(&tauri::WindowEvent::Focused(true)));
    }
}
