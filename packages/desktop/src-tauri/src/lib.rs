//! hReader 桌面壳：把"定位 `hr` → 拉起/复用本地 daemon → 把 webview 导航到 `/s/<docId>?t=…`"装配起来。
//!
//! 纯逻辑模块（`options`/`open_arg`/`cli_locate`/`daemon_file`/`spawn_decision`/`child_registry`/
//! `shortcut`/`url_build`/`redact`）不碰 syscall，`supervisor`/`smoke`/`window` 才是副作用层。

pub mod child_registry;
pub mod cli_locate;
pub mod daemon_file;
pub mod open_arg;
pub mod options;
pub mod redact;
pub mod shortcut;
pub mod signals;
pub mod spawn_decision;
pub mod supervisor;
pub mod url_build;
pub mod workbench;

mod smoke;
mod window;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cli_locate::LocateError;
use daemon_file::BadDaemonFile;
use open_arg::{Action, OpenArgError};
use options::ShellOptions;
use spawn_decision::{decide, recheck, Conflict, Decision, Probe, RecheckError};
use supervisor::{Daemon, SuperviseError, SystemProbe};
use url_build::PathError;

/// 收尸的唯一入口：三条退出路径（`--hold`、GUI 正常退出、GUI 关窗）都调它。
///
/// 幂等：`Daemon` 被 `take()` 走之后 `Drop` 只会跑一次，所以多加一道调用点只是多一次空操作。
#[derive(Clone)]
pub struct Reaper {
    slot: Arc<Mutex<Option<Daemon>>>,
}

impl Reaper {
    pub fn new(daemon: Daemon) -> Self {
        Self {
            slot: Arc::new(Mutex::new(Some(daemon))),
        }
    }

    pub fn reap(&self) {
        let taken = match self.slot.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        drop(taken);
    }
}

/// 一次启动的产物：daemon 关系（带着收尸能力）+ webview 该去的地址与工作区上下文。
pub struct Session {
    pub daemon: Reaper,
    pub url: String,
    pub reader_url: Option<String>,
    pub port: u16,
    pub token: String,
    pub workspace: PathBuf,
    pub doc_id: String,
    pub cli: PathBuf,
    /// 信号订阅随 session 一起活：`connect` 期间就装好了，提前丢了等于没装。
    _signals: signals::SignalSubscription,
}

#[derive(Debug)]
pub enum StartupError {
    Open(OpenArgError),
    Locate(LocateError),
    DaemonFile(BadDaemonFile),
    Conflict(Conflict),
    Supervise(SuperviseError),
    NoDocument(PathBuf),
    BadDocId(PathError),
    DaemonGone,
    HomeUnwritable(PathBuf),
}

impl std::fmt::Display for StartupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open(OpenArgError::MissingValue) => {
                write!(formatter, "--open 后面要跟一个文档路径")
            }
            Self::Open(OpenArgError::OutsideWorkspace { path }) => {
                write!(formatter, "文档 {path} 不在 workspace 内")
            }
            Self::Open(OpenArgError::NotHtmlDocument { path }) => {
                write!(formatter, "{path} 不是 .html/.htm 文档")
            }
            Self::Locate(LocateError::ExplicitMissing(path)) => {
                write!(formatter, "--cli-path 指向的 {} 不存在", path.display())
            }
            Self::Locate(LocateError::NotFound) => write!(
                formatter,
                "找不到 hr CLI：装一下 @hreader/cli，或用 --cli-path / HREADER_CLI 指定"
            ),
            Self::DaemonFile(bad) => write!(formatter, "{}: {}", bad.path().display(), bad),
            Self::Conflict(Conflict::NotAnHreaderDaemon) => {
                write!(formatter, "端口被非 hReader 进程占着：换一个端口或先关掉它")
            }
            Self::Conflict(Conflict::PortOwnedByOther) => {
                write!(
                    formatter,
                    "daemon.json 里的端口被别的进程占着：删掉它或换一个端口"
                )
            }
            Self::Supervise(error) => write!(formatter, "{error}"),
            Self::NoDocument(workspace) => {
                write!(formatter, "{} 里没有 .html 文档可打开", workspace.display())
            }
            Self::BadDocId(error) => write!(formatter, "{error}"),
            Self::DaemonGone => {
                write!(formatter, "daemon 在打开窗口前退出了：再启动一次试试")
            }
            Self::HomeUnwritable(home) => {
                write!(
                    formatter,
                    "建不出壳自己的数据目录 {}：检查权限",
                    home.display()
                )
            }
        }
    }
}

/// 整个壳的入口：`--smoke` 走无窗口链路，其余开窗口。
pub fn run(argv: &[String]) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let home = match default_home() {
        Ok(home) => home,
        Err(reason) => {
            eprintln!("{reason}");
            return 1;
        }
    };
    let mut options = match options::parse(argv, &cwd, &home) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("参数有误：{error}");
            return 1;
        }
    };
    if options.smoke {
        return smoke::run(argv, &options);
    }
    // 必须在 `connect()` 之前装上：`connect` 里有"已 spawn、还没 own"的窗口（最长 `READY_TIMEOUT`），
    // 那段时间被 SIGTERM 掉就没人收尸。类型上的说法是 `connect_with` 必须收下这个 token。
    let _before_connect = signals::watch();
    prepare_gui_launch(argv, &cwd, &mut options);
    if let Some(seconds) = options.hold {
        return hold(argv, &options, Duration::from_secs(seconds));
    }
    match connect(argv, &options, _before_connect) {
        Ok(session) => {
            save_last_workspace(&options.home, &session.workspace);
            window::run(window::LaunchTarget::Session(session))
        }
        Err(StartupError::NoDocument(_)) => match locate_cli(&options) {
            Ok(cli) => {
                save_last_workspace(&options.home, &options.workspace);
                window::run(window::LaunchTarget::Empty {
                    workspace: options.workspace,
                    cli,
                })
            }
            Err(cli_err) => {
                let message = cli_err.to_string();
                eprintln!("{message}");
                show_native_error("hReader 启动失败", &message);
                1
            }
        },
        Err(error) => {
            let message = error.to_string();
            eprintln!("{message}");
            show_native_error("hReader 启动失败", &message);
            1
        }
    }
}

fn has_flag(argv: &[String], flag: &str) -> bool {
    argv.iter().any(|token| token == flag)
}

fn raw_doc_arg(argv: &[String]) -> Option<&str> {
    if let Some(idx) = argv.iter().position(|token| token == "--open") {
        return argv.get(idx + 1).map(String::as_str);
    }
    let mut index = 0;
    while index < argv.len() {
        let token = argv[index].as_str();
        if options::VALUE_FLAGS.contains(&token) {
            index += 2;
            continue;
        }
        if !token.starts_with('-') {
            return Some(token);
        }
        index += 1;
    }
    None
}

const LAST_WORKSPACE_FILE: &str = "last-workspace.txt";

pub(crate) fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

pub(crate) fn save_last_workspace(home: &Path, workspace: &Path) {
    if is_filesystem_root(workspace) || !workspace.is_dir() {
        return;
    }
    if std::fs::create_dir_all(home).is_ok() {
        let _ = std::fs::write(
            home.join(LAST_WORKSPACE_FILE),
            workspace.to_string_lossy().as_bytes(),
        );
    }
}

pub(crate) fn load_last_workspace(home: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(home.join(LAST_WORKSPACE_FILE)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_dir() && !is_filesystem_root(&path) {
        Some(path)
    } else {
        None
    }
}

fn default_gui_workspace(home: &Path) -> Option<PathBuf> {
    if let Some(last) = load_last_workspace(home) {
        return Some(last);
    }
    let home_root = home_from_env(|name| std::env::var_os(name)).ok()?;
    let docs_dir = home_root.join("Documents").join("hReader");
    if std::fs::create_dir_all(&docs_dir).is_ok() {
        return Some(docs_dir);
    }
    None
}

/// 保证手写 `.html` 已带 `data-hr-id`，避免桌面端打开即被 `hr serve` 拒收。
pub(crate) fn ensure_doc_ready(cli: &Path, workspace: &Path, doc_id: &str) {
    let target = workspace.join(doc_id);
    let Ok(html) = std::fs::read_to_string(&target) else {
        return;
    };
    if html.contains("data-hr-id=") {
        return;
    }
    let _ = supervisor::run_cli_task(cli, workspace, &["normalize", doc_id, "--write"]);
}

/// 若桌面壳私有目录里残留着**另一个工作区**的 daemon，先停掉它，确保新打开的文档/工作区不被旧 daemon 拒收。
pub(crate) fn clear_other_workspace_daemon(home: &Path, target_workspace: &Path) {
    let file = daemon_file::daemon_file_in(home);
    if let Ok(daemon_file::DaemonState::Present(info)) = daemon_file::read_daemon(&file) {
        if info.workspace != target_workspace {
            supervisor::stop_pid(info.pid);
            let _ = std::fs::remove_file(&file);
            std::thread::sleep(Duration::from_millis(120));
        }
    }
}

fn prepare_gui_launch(argv: &[String], cwd: &Path, options: &mut ShellOptions) {
    if !has_flag(argv, "--workspace") {
        if let Some(raw_doc) = raw_doc_arg(argv) {
            let candidate = Path::new(raw_doc);
            let abs = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                cwd.join(candidate)
            };
            if abs.is_file() {
                if let Some(parent) = abs.parent() {
                    options.workspace = parent.to_path_buf();
                }
            }
        } else if is_filesystem_root(&options.workspace)
            || workbench::list_html_files(&options.workspace).is_empty()
        {
            if let Some(fallback_ws) = default_gui_workspace(&options.home) {
                options.workspace = fallback_ws;
            }
        }
    }
    clear_other_workspace_daemon(&options.home, &options.workspace);
    if let Ok(action) = open_arg::action_of(argv, &options.workspace) {
        if let (Ok(doc_id), Ok(cli)) = (
            document_of(&action, &options.workspace),
            locate_cli(options),
        ) {
            ensure_doc_ready(&cli, &options.workspace, &doc_id);
        }
    }
}

#[cfg(target_os = "macos")]
fn show_native_error(title: &str, message: &str) {
    let script = format!(
        "display alert {:?} message {:?} as critical",
        title, message
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(not(target_os = "macos"))]
fn show_native_error(_title: &str, _message: &str) {}

/// `--hold <secs>`：无窗口、跑满一段时间或收到 SIGTERM/SIGINT 就退出，给信号处理一个可测的靶子。
fn hold(argv: &[String], options: &ShellOptions, timeout: Duration) -> i32 {
    let session = match connect(argv, options, signals::watch()) {
        Ok(session) => session,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    signals::watch();
    signals::wait_or_timeout(timeout);
    session.daemon.reap();
    0
}

/// 定位 + 探活 + 拉起/复用，最后拼出 webview 的首个地址。
///
/// `subscription` 必须由调用点先 `signals::watch()` 拿到：本函数里就有"已 spawn、还没 own"的窗口，
/// 把顺序写进签名后，"先 connect 后 watch"就是编译错误，而不是一条需要人记得的约定。
pub fn connect(
    argv: &[String],
    options: &ShellOptions,
    subscription: signals::SignalSubscription,
) -> Result<Session, StartupError> {
    connect_with(argv, options, &SystemProbe, subscription)
}

/// 探活能力可注入："判定是复用、真导航前端口却换手了"这种现场只能靠假探针造出来。
/// `signals` 这个实参是顺序保险，不是配置：拿到它的唯一办法是先 `signals::watch()`。
pub fn connect_with(
    argv: &[String],
    options: &ShellOptions,
    probe: &dyn Probe,
    signals: signals::SignalSubscription,
) -> Result<Session, StartupError> {
    let action = open_arg::action_of(argv, &options.workspace).map_err(StartupError::Open)?;
    // 没有文档参数时也必须有 docId：只有 `/s/<docId>?t=` 会下发 cookie，`/` 不会。
    let doc_id = document_of(&action, &options.workspace)?;
    let cli = locate_cli(options)?;
    let state = daemon_file::read_daemon(&daemon_file::daemon_file_in(&options.home))
        .map_err(StartupError::DaemonFile)?;

    let app_dir = supervisor::default_app_dir();
    let daemon = match decide(&state, probe) {
        Decision::Reuse(info) => {
            // TOCTOU：判定之后、带 token 导航之前必须再核一次，否则抢到端口的人就能看到 `?t=`。
            match recheck(&info, probe) {
                Ok(()) => Daemon::adopted(info),
                Err(RecheckError::Conflicted(conflict)) => {
                    return Err(StartupError::Conflict(conflict))
                }
                Err(RecheckError::Gone) => return Err(StartupError::DaemonGone),
            }
        }
        Decision::Conflicted(conflict) => return Err(StartupError::Conflict(conflict)),
        Decision::Spawn { .. } => {
            // 壳自己的 home 可能还不存在（首次启动）；`hr serve --home` 要求目录已存在（不然打错字
            // 家目录会变成隐形的新 home），所以由壳先建。
            std::fs::create_dir_all(&options.home)
                .map_err(|_| StartupError::HomeUnwritable(options.home.clone()))?;
            Daemon::spawn_with_app(
                &cli,
                &doc_id,
                &options.workspace,
                &options.home,
                options.port,
                app_dir.as_deref(),
            )
            .map_err(StartupError::Supervise)?
        }
    };

    let info = daemon.info().clone();
    let url = url_build::bootstrap_url(info.port, &doc_id, &info.token)
        .map_err(StartupError::BadDocId)?;
    let reader_url = app_dir.map(|_| url_build::reader_url(info.port, &info.token));
    Ok(Session {
        daemon: Reaper::new(daemon),
        url,
        reader_url,
        port: info.port,
        token: info.token,
        workspace: options.workspace.clone(),
        doc_id,
        cli,
        _signals: signals,
    })
}

pub(crate) fn fallback_cli_path() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for rel in [
                "../Resources/resources/cli/cli.mjs",
                "../Resources/cli/cli.mjs",
                "../Resources/cli/hr.mjs",
                "resources/cli/cli.mjs",
                "resources/cli/hr.mjs",
            ] {
                let bundled = exe_dir.join(rel);
                if bundled.is_file() {
                    return Some(bundled);
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    for sys_cli in [
        "/usr/lib/hReader/resources/cli/cli.mjs",
        "/usr/lib/hreader-desktop/resources/cli/cli.mjs",
    ] {
        let candidate = Path::new(sys_cli);
        if candidate.is_file() {
            return Some(candidate.to_path_buf());
        }
    }
    let repo_hr =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../skills/hreader/scripts/hr.mjs");
    if repo_hr.is_file() {
        return repo_hr.canonicalize().ok().or(Some(repo_hr));
    }
    None
}

fn locate_cli(options: &ShellOptions) -> Result<PathBuf, StartupError> {
    let env_cli = std::env::var_os("HREADER_CLI").map(PathBuf::from);
    let path_var = std::env::var("PATH").ok();
    match cli_locate::locate(
        options.cli_path.as_deref(),
        env_cli.as_deref(),
        path_var.as_deref(),
        &|candidate: &Path| candidate.is_file(),
    ) {
        Ok(located) => Ok(located.cli),
        Err(LocateError::NotFound) if options.cli_path.is_none() => {
            fallback_cli_path().ok_or(StartupError::Locate(LocateError::NotFound))
        }
        Err(error) => Err(StartupError::Locate(error)),
    }
}

/// 没有文档参数时给 `hr serve` 的默认文档：workspace 里第一个 `.html`（按名字排序，含子文件夹）。
pub(crate) fn document_of(action: &Action, workspace: &Path) -> Result<String, StartupError> {
    if let Action::OpenDocument { doc_id } = action {
        return Ok(doc_id.clone());
    }
    if is_filesystem_root(workspace) {
        return Err(StartupError::NoDocument(workspace.into()));
    }
    workbench::list_html_files(workspace)
        .into_iter()
        .next()
        .ok_or_else(|| StartupError::NoDocument(workspace.into()))
}

/// 壳只对外说一句能读懂的话；`Display` 里不含 token，所以直接用它。
pub(crate) fn startup_message(error: &StartupError) -> String {
    error.to_string()
}

/// 壳的数据目录：`HOME` 优先，Windows 常规只有 `USERPROFILE`。
///
/// **不回退 `"."`**：那会把 `daemon.json` 写进 cwd（可能是任意仓库），正是 W7 要防的污染。
/// 两个变量都没有时只能失败——壳自己也不知道该把状态放哪。
pub fn default_home() -> Result<PathBuf, String> {
    home_from_env(|name| std::env::var_os(name)).map(|home| default_home_for(&home))
}

/// 取 home 的纯函数部分：`lookup` 注入环境，测试才能逐支断言（真 `std::env` 改不得）。
///
/// `HOME` 优先，Windows 常规只有 `USERPROFILE`；两个都没有时**不回退 `"."`**。
pub fn home_from_env(lookup: impl Fn(&str) -> Option<OsString>) -> Result<PathBuf, String> {
    match lookup("HOME").or_else(|| lookup("USERPROFILE")) {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ => {
            Err("找不到用户目录：HOME 与 USERPROFILE 都没设，无法定位壳的 daemon.json".to_string())
        }
    }
}

/// tauri 的 app data 子目录名：与 `tauri.conf.json` 的 `identifier` 一致，
/// 也就是说这里算出来的位置和 `app.path().app_data_dir()` 是同一个。
pub const APP_DATA_DIR: &str = "com.hreader.desktop";

/// 壳自己的 home 必须是**应用私有目录**，绝不能是 `$HOME`。
///
/// 用 `$HOME` 的后果不是风格问题而是污染用户数据：壳会读到用户自己的 `~/.hreader/daemon.json`、
/// 把 `$HOME` 当 `--home` 透传给 `hr serve`，于是启动覆写、退出删掉用户那个 daemon 的记录。
/// 纯函数（只做平台映射），便于对任意 `$HOME` 断言落点。
pub fn default_home_for(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support").join(APP_DATA_DIR)
    } else if cfg!(target_os = "windows") {
        home.join("AppData/Roaming").join(APP_DATA_DIR)
    } else {
        home.join(".local/share").join(APP_DATA_DIR)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 一档图标数据只可能是 PNG（`PNG\r\n\x1a\n`）或 32bpp DIB（40 字节 `BITMAPINFOHEADER`）。
    const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    const PNG_IEND: [u8; 8] = [b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82];

    /// 假环境：只认给定的那几对，其余一律"没设"（真 `std::env` 在测试里改不得）。
    fn test_lookup(
        pairs: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str) -> Option<OsString> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(*value))
        }
    }

    #[test]
    fn home_from_env_prefers_home() {
        let env = test_lookup(&[("HOME", "/home/me"), ("USERPROFILE", "C:/Users/win")]);
        assert_eq!(
            home_from_env(env).expect("HOME 应当胜出"),
            PathBuf::from("/home/me")
        );
    }

    #[test]
    fn home_from_env_falls_back_to_userprofile() {
        // Windows 常规只有 USERPROFILE：只读 HOME 的实现在那边等于"没有数据目录"。
        let env = test_lookup(&[("USERPROFILE", "C:/Users/win")]);
        let home = home_from_env(env).expect("USERPROFILE 应当兜底");
        assert_eq!(home, PathBuf::from("C:/Users/win"));
        assert!(default_home_for(&home).ends_with(APP_DATA_DIR));
    }

    #[test]
    fn home_from_env_errors_instead_of_falling_back_to_cwd() {
        // 回退 "." 会把 daemon.json 写进 cwd（可能是任意仓库），正违背 W7。
        let error = home_from_env(test_lookup(&[])).expect_err("两个变量都没有时必须失败");
        assert!(error.contains("USERPROFILE"), "错误里要说清差什么：{error}");
    }

    /// 校验一份 ICO：目录项、偏移、payload 结构。
    /// 抽成函数是为了能被伪造样本反向打靶——判据只有在能红的时候才算判据。
    fn assert_valid_ico(bytes: &[u8], expected_sizes: &[(u8, u8)]) {
        assert!(bytes.len() >= 6, "ICO 头不足 6 字节：{}", bytes.len());
        assert_eq!(&bytes[..4], &[0, 0, 1, 0], "ICO 头必须是 00 00 01 00");
        let entries = usize::from(u16::from_le_bytes([bytes[4], bytes[5]]));
        assert_eq!(
            entries,
            expected_sizes.len(),
            "目录项数 {entries} 与期望 {} 不符",
            expected_sizes.len()
        );
        let dir_end = 6 + entries * 16;
        assert!(
            dir_end <= bytes.len(),
            "目录区越界：{dir_end} > {}",
            bytes.len()
        );

        // 每项 16 字节：宽/高/调色板/保留/平面/位深/字节数/偏移；宽或高写 0 表示 256。
        // 偏移从目录区末尾起、逐档不回头：这样"数据真在文件里"而不是靠 offset+size<=len 的 0+0 恒真。
        let mut previous_end = dir_end;
        for (index, (width, height)) in expected_sizes.iter().enumerate() {
            let entry = &bytes[6 + index * 16..6 + (index + 1) * 16];
            assert_eq!(entry[0], *width, "第 {index} 档宽度");
            assert_eq!(entry[1], *height, "第 {index} 档高度");
            let size = u32::from_le_bytes([entry[8], entry[9], entry[10], entry[11]]) as usize;
            let offset = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as usize;
            assert!(size > 0, "第 {index} 档没有数据（size={size}）");
            assert!(
                offset >= previous_end,
                "第 {index} 档起点 {offset} 压住了上一档（数据结束于 {previous_end}）"
            );
            let end = offset + size;
            assert!(
                end <= bytes.len(),
                "第 {index} 档数据越界：{offset}+{size} > {}",
                bytes.len()
            );
            let payload = &bytes[offset..end];
            if payload.starts_with(&PNG_SIGNATURE) {
                // PNG 必须以 IHDR 开头：`签名 + IEND` 16 字节伪造首尾都像，中间却没有 IHDR。
                assert_eq!(
                    payload.get(12..16),
                    Some(&b"IHDR"[..]),
                    "第 {index} 档 PNG 必须以 IHDR 开头，实际 {:02x?}",
                    payload.get(12..16)
                );
                assert!(
                    payload.ends_with(&PNG_IEND),
                    "第 {index} 档 PNG 缺少 IEND 收尾"
                );
                assert!(
                    payload.len() >= 45,
                    "第 {index} 档 PNG 至少 45 字节，实际 {}",
                    payload.len()
                );
            } else {
                // 位深从载荷的 `biBitCount` 读，不读目录项里的位域（目录项可以写 32 而载荷是 8bpp）。
                assert!(
                    payload.len() >= 40,
                    "第 {index} 档 DIB 至少 40 字节（BITMAPINFOHEADER），实际 {}",
                    payload.len()
                );
                assert_eq!(
                    u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]),
                    40,
                    "第 {index} 档 DIB 的 biSize 必须是 40"
                );
                assert_eq!(
                    u16::from_le_bytes([payload[14], payload[15]]),
                    32,
                    "第 {index} 档 DIB 的 biBitCount 必须是 32"
                );
            }
            previous_end = end;
        }
    }

    /// 造一份假 ICO：每档 (宽, 高, size, offset)，目录后面跟整段 payload。
    fn fake_ico(entries: &[(u8, u8, u32, u32)], payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0, 0, 1, 0];
        bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (width, height, size, offset) in entries {
            bytes.extend_from_slice(&[*width, *height, 0, 0, 1, 0, 32, 0]);
            bytes.extend_from_slice(&size.to_le_bytes());
            bytes.extend_from_slice(&offset.to_le_bytes());
        }
        bytes.extend_from_slice(payload);
        bytes
    }

    /// 取 panic payload 的文本：`panic!` 的两种形态是 `&str` 与 `String`。
    fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
        payload
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<非字符串 panic payload>".to_string())
    }

    #[test]
    fn bundle_icon_ico_is_a_valid_ico_with_four_sizes() {
        // Windows 的 tauri-build 直接读 `icons/icon.ico`，本机没有 windows target：这条是唯一守门人。
        assert_valid_ico(
            include_bytes!("../icons/icon.ico"),
            &[(16, 16), (32, 32), (48, 48), (0, 0)],
        );
    }

    #[test]
    #[should_panic(expected = "第 0 档没有数据")]
    fn ico_rejects_empty_directory_with_zero_sizes() {
        // 70 字节空目录：四档宽高都对，但 size/offset 全 0——旧判据靠 `offset+size<=len` 的 0+0 恒真放过它。
        let bytes = fake_ico(
            &[(16, 16, 0, 0), (32, 32, 0, 0), (48, 48, 0, 0), (0, 0, 0, 0)],
            &[],
        );
        assert_eq!(bytes.len(), 70, "空目录样本必须正好 70 字节");
        assert_valid_ico(&bytes, &[(16, 16), (32, 32), (48, 48), (0, 0)]);
    }

    #[test]
    #[should_panic(expected = "至少 40 字节")]
    fn ico_rejects_dib_without_payload() {
        // 目录项自洽、位域写着 32bpp，payload 却只有 4 字节 DIB 签名：旧判据读 `entry[6..8]` 照样全过。
        let bytes = fake_ico(&[(16, 16, 4, 22)], &[0x28, 0, 0, 0]);
        assert_eq!(bytes.len(), 26);
        assert_valid_ico(&bytes, &[(16, 16)]);
    }

    #[test]
    #[should_panic(expected = "必须以 IHDR 开头")]
    fn ico_rejects_png_marker_without_ihdr() {
        // `PNG 签名 + IEND` 共 16 字节：签名与收尾都对，中间没有 IHDR——"判据吹得比实际贵"的样本。
        let mut payload = PNG_SIGNATURE.to_vec();
        payload.extend_from_slice(&PNG_IEND);
        let bytes = fake_ico(&[(16, 16, 16, 22)], &payload);
        assert_eq!(bytes.len(), 38);
        assert_valid_ico(&bytes, &[(16, 16)]);
    }

    #[test]
    fn ico_rejects_png_without_iend_tail() {
        // 签名 8 + 合规 IHDR 块 25 + 假 IDAT 块 16 = 49 字节：IHDR 与长度门槛都过，
        // 只有"以 IEND 收尾"能拒它——否则那行断言永远红不了，等于没有。
        let mut payload = PNG_SIGNATURE.to_vec();
        payload.extend_from_slice(&[0, 0, 0, 13]); // IHDR 长度
        payload.extend_from_slice(b"IHDR");
        payload.extend_from_slice(&[0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0]); // 16x16 / 8bpp / RGBA
        payload.extend_from_slice(&[0, 0, 0, 0]); // IHDR CRC 占位：判据不看 CRC
        payload.extend_from_slice(&[0, 0, 0, 8]); // 假 IDAT 长度
        payload.extend_from_slice(b"IDAT");
        payload.extend_from_slice(&[0x00; 8]);
        assert_eq!(payload.len(), 49, "样本必须过 45 字节门槛");
        let bytes = fake_ico(&[(16, 16, 49, 22)], &payload);

        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert_valid_ico(&bytes, &[(16, 16)]);
        }))
        .expect_err("IHDR 合规、长度 49 却缺 IEND 的样本必须被拒");
        let message = panic_message(&*panic);
        assert!(
            message.contains("IEND"),
            "应被 IEND 分支拒，实际：{message}"
        );
    }

    #[test]
    fn ico_rejects_png_under_45_bytes() {
        // 签名 8 + 合法 IHDR 块 25 + IEND 序列 8 = 41 字节：IHDR 与 IEND 两侧都过
        // （IEND 判据只看 8 字节序列、不看 4 字节长度前缀），只有"至少 45 字节"能拒它。
        // 45 = 签名 8 + IHDR 块 25 + **完整 IEND 块** 12，所以这条断言判的是块结构完整。
        let mut payload = PNG_SIGNATURE.to_vec();
        payload.extend_from_slice(&[0, 0, 0, 13]); // IHDR 长度
        payload.extend_from_slice(b"IHDR");
        payload.extend_from_slice(&[0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0]); // 16x16 / 8bpp / RGBA
        payload.extend_from_slice(&[0, 0, 0, 0]); // IHDR CRC 占位：判据不看 CRC
        payload.extend_from_slice(&PNG_IEND);
        assert_eq!(
            payload.len(),
            41,
            "样本必须 41 字节：一侧过 IHDR/IEND，一侧过不了 45"
        );
        let bytes = fake_ico(&[(16, 16, 41, 22)], &payload);

        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert_valid_ico(&bytes, &[(16, 16)]);
        }))
        .expect_err("41 字节的 PNG 样本必须被拒");
        let message = panic_message(&*panic);
        assert!(
            message.contains("至少 45 字节"),
            "应被长度断言拒（不是 IHDR/IEND 兜住），实际：{message}"
        );
    }

    #[test]
    fn shell_home_is_app_scoped_and_never_the_user_home() {
        let user_home = Path::new("/Users/x");
        let shell_home = default_home_for(user_home);
        assert_ne!(shell_home, user_home, "绝不能用 $HOME 本身");
        assert_ne!(
            shell_home.join(".hreader"),
            user_home.join(".hreader"),
            "绝不能和用户自己的 ~/.hreader 是同一个目录"
        );
        assert!(
            shell_home.starts_with(user_home),
            "{} 应在 home 里",
            shell_home.display()
        );
        assert!(
            shell_home.ends_with(APP_DATA_DIR),
            "{} 应是 app data 目录",
            shell_home.display()
        );
    }

    #[test]
    fn daemon_file_lands_outside_the_user_store() {
        let user_home = Path::new("/Users/x");
        let file = daemon_file::daemon_file_in(&default_home_for(user_home));
        assert_ne!(file, user_home.join(".hreader/daemon.json"));
        assert!(
            file.components()
                .any(|part| part.as_os_str() == APP_DATA_DIR),
            "{} 应在 app data 目录下",
            file.display()
        );
    }

    #[test]
    fn prepare_gui_launch_never_stays_on_filesystem_root() {
        let root = std::env::temp_dir().join(format!("hr-lib-root-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let fallback_ws = root.join("vault");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&fallback_ws).expect("create vault");
        save_last_workspace(&home, &fallback_ws);

        let mut options = ShellOptions {
            smoke: false,
            home: home.clone(),
            workspace: PathBuf::from("/"),
            cli_path: None,
            port: None,
            hold: None,
        };
        prepare_gui_launch(&[], Path::new("/"), &mut options);
        assert!(
            !is_filesystem_root(&options.workspace),
            "Finder launch cwd='/' must never remain '/': {}",
            options.workspace.display()
        );
        assert_eq!(options.workspace, fallback_ws);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn document_of_finds_nested_html_in_subfolders() {
        let root = std::env::temp_dir().join(format!("hr-lib-nested-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("notes/sub")).expect("create sub");
        fs::write(root.join("notes/sub/first.html"), "<p>hi</p>").expect("write html");
        let found = document_of(&Action::NoAction, &root).expect("should find nested");
        assert_eq!(found, "notes/sub/first.html");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn document_of_returns_no_document_for_empty_workspace() {
        let root = std::env::temp_dir().join(format!("hr-lib-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("empty-sub")).expect("create empty");
        fs::write(root.join("notes.txt"), "not html").expect("write txt");
        let err = document_of(&Action::NoAction, &root).expect_err("empty workspace must err");
        assert!(matches!(err, StartupError::NoDocument(_)), "{err:?}");
        assert!(matches!(
            document_of(&Action::NoAction, Path::new("/")),
            Err(StartupError::NoDocument(_))
        ));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn last_workspace_roundtrip_ignores_filesystem_root() {
        let root = std::env::temp_dir().join(format!("hr-lib-lastws-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        let vault = root.join("vault");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&vault).expect("create vault");

        save_last_workspace(&home, Path::new("/"));
        assert_eq!(load_last_workspace(&home), None);

        save_last_workspace(&home, &vault);
        assert_eq!(load_last_workspace(&home), Some(vault));
        let _ = fs::remove_dir_all(&root);
    }
}
