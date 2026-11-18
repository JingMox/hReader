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

/// 一次启动的产物：daemon 关系（带着收尸能力）+ webview 该去的地址。
pub struct Session {
    pub daemon: Reaper,
    pub url: String,
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
    let options = match options::parse(argv, &cwd, &home) {
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
    if let Some(seconds) = options.hold {
        return hold(argv, &options, Duration::from_secs(seconds));
    }
    match connect(argv, &options, _before_connect) {
        Ok(session) => {
            let url = session.url.clone();
            window::run(url, session)
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

/// `--hold <secs>`：无窗口、跑满一段时间或收到 SIGTERM/SIGINT 就退出，给 AC-14 一个可测的靶子。
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
            Daemon::spawn(
                &cli,
                &doc_id,
                &options.workspace,
                &options.home,
                options.port,
            )
            .map_err(StartupError::Supervise)?
        }
    };

    let info = daemon.info();
    let url = url_build::bootstrap_url(info.port, &doc_id, &info.token)
        .map_err(StartupError::BadDocId)?;
    Ok(Session {
        daemon: Reaper::new(daemon),
        url,
        _signals: signals,
    })
}

fn locate_cli(options: &ShellOptions) -> Result<PathBuf, StartupError> {
    let env_cli = std::env::var_os("HREADER_CLI").map(PathBuf::from);
    let path_var = std::env::var("PATH").ok();
    let located = cli_locate::locate(
        options.cli_path.as_deref(),
        env_cli.as_deref(),
        path_var.as_deref(),
        &|candidate: &Path| candidate.is_file(),
    )
    .map_err(StartupError::Locate)?;
    Ok(located.cli)
}

/// 没有文档参数时给 `hr serve` 的默认文档：workspace 里第一个 `.html`（按名字排序）。
pub(crate) fn document_of(action: &Action, workspace: &Path) -> Result<String, StartupError> {
    if let Action::OpenDocument { doc_id } = action {
        return Ok(doc_id.clone());
    }
    let entries =
        std::fs::read_dir(workspace).map_err(|_| StartupError::NoDocument(workspace.into()))?;
    let mut candidates: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            Path::new(name).extension().is_some_and(|extension| {
                extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
            })
        })
        .collect();
    candidates.sort();
    match candidates.first() {
        Some(name) => Ok(name.clone()),
        None => Err(StartupError::NoDocument(workspace.into())),
    }
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

    /// 一档图标数据只可能是 PNG（`PNG\r\n\x1a\n`）或 32bpp DIB（40 字节 `BITMAPINFOHEADER`）。
    const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    const PNG_IEND: [u8; 8] = [b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82];
    const DIB_HEADER_SIGNATURE: [u8; 4] = [0x28, 0x00, 0x00, 0x00];

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
    fn r2_home_from_env_prefers_home() {
        let env = test_lookup(&[("HOME", "/home/me"), ("USERPROFILE", "C:/Users/win")]);
        assert_eq!(
            home_from_env(env).expect("HOME 应当胜出"),
            PathBuf::from("/home/me")
        );
    }

    #[test]
    fn r2_home_from_env_falls_back_to_userprofile() {
        // Windows 常规只有 USERPROFILE：只读 HOME 的实现在那边等于"没有数据目录"。
        let env = test_lookup(&[("USERPROFILE", "C:/Users/win")]);
        let home = home_from_env(env).expect("USERPROFILE 应当兜底");
        assert_eq!(home, PathBuf::from("C:/Users/win"));
        assert!(default_home_for(&home).ends_with(APP_DATA_DIR));
    }

    #[test]
    fn r2_home_from_env_errors_instead_of_falling_back_to_cwd() {
        // 回退 "." 会把 daemon.json 写进 cwd（可能是任意仓库），正违背 W7。
        let error = home_from_env(test_lookup(&[])).expect_err("两个变量都没有时必须失败");
        assert!(error.contains("USERPROFILE"), "错误里要说清差什么：{error}");
    }

    #[test]
    fn r1_bundle_icon_ico_is_a_valid_ico_with_four_sizes() {
        // Windows 的 tauri-build 直接读 `icons/icon.ico`，本机没有 windows target：这条是唯一守门人。
        // 判据要贵过空目录：70 字节的假目录（size/offset 全 0）过不了；再抽查 payload 首尾
        // （PNG 签名 + IEND 收尾 / DIB biSize==40 + 32bpp），但仍不还原整张图。
        let bytes = include_bytes!("../icons/icon.ico");
        assert_eq!(&bytes[..4], &[0, 0, 1, 0], "ICO 头必须是 00 00 01 00");
        let entries = usize::from(u16::from_le_bytes([bytes[4], bytes[5]]));
        assert_eq!(entries, 4, "16/32/48/256 四档，多一档少一档都算坏");
        let dir_end = 6 + entries * 16;
        assert!(
            dir_end <= bytes.len(),
            "目录区越界：{dir_end} > {}",
            bytes.len()
        );

        // 每项 16 字节：宽/高/调色板/保留/平面/位深/字节数/偏移；宽或高写 0 表示 256。
        // 偏移从目录区末尾起、逐档不回头：这样"数据真在文件里"而不是靠 offset+size<=len 的 0+0 恒真。
        let mut previous_end = dir_end;
        for (index, (width, height)) in [(16_u8, 16_u8), (32, 32), (48, 48), (0, 0)]
            .iter()
            .enumerate()
        {
            let entry = &bytes[6 + index * 16..6 + (index + 1) * 16];
            assert_eq!(entry[0], *width, "第 {index} 档宽度");
            assert_eq!(entry[1], *height, "第 {index} 档高度");
            let size = u32::from_le_bytes([entry[8], entry[9], entry[10], entry[11]]) as usize;
            let offset = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as usize;
            assert!(size > 0, "第 {index} 档没有数据");
            assert!(
                offset >= previous_end,
                "第 {index} 档起点 {offset} 压住了上一档（数据结束于 {previous_end}）"
            );
            let end = offset + size;
            assert!(end <= bytes.len(), "第 {index} 档数据越界：{offset}+{size}");
            let payload = &bytes[offset..end];
            assert!(
                payload.starts_with(&PNG_SIGNATURE) || payload.starts_with(&DIB_HEADER_SIGNATURE),
                "第 {index} 档 payload 既不是 PNG 也不是 32bpp DIB：{:02x?}",
                &payload[..4.min(payload.len())]
            );
            if payload.starts_with(&PNG_SIGNATURE) {
                assert!(
                    payload.ends_with(&PNG_IEND),
                    "第 {index} 档 PNG 缺少 IEND 收尾"
                );
            } else {
                let bit_count = u16::from_le_bytes([entry[6], entry[7]]);
                assert_eq!(bit_count, 32, "第 {index} 档 DIB 必须是 32bpp");
            }
            previous_end = end;
        }
    }

    #[test]
    fn ac11_shell_home_is_app_scoped_and_never_the_user_home() {
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
    fn ac11_daemon_file_lands_outside_the_user_store() {
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
}
