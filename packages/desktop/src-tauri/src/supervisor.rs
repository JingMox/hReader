//! 平台副作用层：探活用的真实 syscall、拉起 `hr`、读它的启动信封、退出时收尸。
//! 判断逻辑在 `spawn_decision`/`child_registry`，这里只负责"真的去做"。

use std::ffi::OsString;
use std::io::{BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::num::NonZeroU16;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::de::IgnoredAny;
use serde::Deserialize;

use crate::child_registry::ChildRegistry;
use crate::daemon_file::DaemonInfo;
use crate::spawn_decision::Probe;

#[derive(Deserialize)]
struct HealthResponse {
    ok: bool,
    pid: Option<u32>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum MaybeData<T> {
    Valid(T),
    #[allow(dead_code)]
    Invalid(IgnoredAny),
}

impl<T> MaybeData<T> {
    fn valid(self) -> Option<T> {
        match self {
            Self::Valid(value) => Some(value),
            Self::Invalid(_) => None,
        }
    }
}

#[derive(Deserialize)]
struct ServeEnvelope {
    ok: Option<bool>,
    code: Option<String>,
    data: Option<MaybeData<ServeEnvelopeData>>,
}

#[derive(Deserialize)]
struct ServeEnvelopeData {
    port: NonZeroU16,
    token: String,
    workspace: PathBuf,
}

const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const READY_INTERVAL: Duration = Duration::from_millis(100);
/// 启动信封必须在 10s 内、64KB 以内出现：坏 CLI 静默挂死或吐洪流都不能让壳跟着死等。
const ENVELOPE_TIMEOUT: Duration = Duration::from_secs(10);
const ENVELOPE_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub enum SuperviseError {
    CannotSpawn(String),
    NoEnvelope,
    /// 子进程还在但迟迟不打印启动信封：杀掉，否则壳永远卡在启动。
    EnvelopeTimeout,
    BadEnvelope,
    /// `hr serve` 自己拒绝了这份文档（信封里带着原因码）；这不是壳解析错了，别混成一句。
    Rejected(String),
    NotReady(u16),
}

impl std::fmt::Display for SuperviseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CannotSpawn(detail) => write!(formatter, "拉不起 hr serve：{detail}"),
            Self::NoEnvelope => write!(formatter, "hr serve 没打印启动信息就退出了"),
            Self::EnvelopeTimeout => write!(
                formatter,
                "hr serve {ENVELOPE_TIMEOUT:?} 内没打印启动信息，已终止"
            ),
            Self::BadEnvelope => write!(formatter, "hr serve 的启动信息不是预期形状"),
            Self::Rejected(code) => write!(formatter, "hr serve 拒绝了这份文档：{code}"),
            Self::NotReady(port) => write!(
                formatter,
                "hr serve 起了但 {READY_TIMEOUT:?} 内没在 {port} 上就绪"
            ),
        }
    }
}

pub struct SystemProbe;

impl Probe for SystemProbe {
    fn port_open(&self, port: u16) -> bool {
        TcpStream::connect_timeout(&address(port), CONNECT_TIMEOUT).is_ok()
    }

    fn process_alive(&self, pid: u32) -> bool {
        #[cfg(unix)]
        {
            Command::new("kill")
                .arg("-0")
                .arg(pid.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        }
        #[cfg(windows)]
        {
            let filter = format!("PID eq {pid}");
            let needle = format!("\"{pid}\"");
            let mut command = Command::new("tasklist");
            command.args(["/FI", &filter, "/FO", "CSV", "/NH"]);
            suppress_console(&mut command);
            command.output().is_ok_and(|out| {
                out.status.success() && String::from_utf8_lossy(&out.stdout).contains(&needle)
            })
        }
    }

    fn health_pid(&self, port: u16) -> Option<u32> {
        let mut stream = TcpStream::connect_timeout(&address(port), CONNECT_TIMEOUT).ok()?;
        stream.set_read_timeout(Some(CONNECT_TIMEOUT)).ok()?;
        let request =
            format!("GET /healthz HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).ok()?;
        let mut response = String::new();
        stream.read_to_string(&mut response).ok()?;
        let body = response.split_once("\r\n\r\n")?.1;
        let parsed: HealthResponse = serde_json::from_str(body).ok()?;
        parsed.ok.then_some(parsed.pid).flatten()
    }
}

fn address(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

/// `spawn_inner` 的两段等待时限：生产路径用模块常量，测试用小值。
#[derive(Debug, Clone, Copy)]
pub(crate) struct SpawnTimeouts {
    pub envelope: Duration,
    pub ready: Duration,
}

/// 壳持有的一段 daemon 关系。`child` 为 `None` 表示复用文件里已有的 daemon（不是壳的孩子）。
pub struct Daemon {
    info: DaemonInfo,
    child: Option<Child>,
    registry: ChildRegistry,
}

/// 阻止 Windows 后台子进程（`node` / `tasklist`）弹出短暂的控制台黑框。
fn suppress_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// 若 CLI 是 `.mjs`/`.js`/`.cjs` 脚本，通过 `node` 启动，避免 Windows 无法直接执行 shebang 脚本。
pub fn cli_command(cli: &Path) -> Command {
    let is_js = cli
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ext.eq_ignore_ascii_case("mjs")
                || ext.eq_ignore_ascii_case("js")
                || ext.eq_ignore_ascii_case("cjs")
        });
    let mut command = if is_js {
        let mut cmd = Command::new("node");
        cmd.arg(cli);
        cmd
    } else {
        Command::new(cli)
    };
    suppress_console(&mut command);
    command
}

impl Daemon {
    pub fn info(&self) -> &DaemonInfo {
        &self.info
    }

    /// 复用别人起的 daemon：只记账为外部，退出时绝不 kill。
    pub fn adopted(info: DaemonInfo) -> Self {
        let mut registry = ChildRegistry::default();
        registry.adopt_external(info.pid);
        Self {
            info,
            child: None,
            registry,
        }
    }

    /// `pub(crate)`：拉 daemon 的入口只能被本 crate 的壳（`lib.rs`/`smoke.rs`）用，
    /// 且必须先把 `SignalSubscription` 交给 `connect_with`——这一层是类型闸要守住的那道门。
    pub(crate) fn spawn(
        cli: &Path,
        doc_id: &str,
        workspace: &Path,
        home: &Path,
        port: Option<u16>,
    ) -> Result<Self, SuperviseError> {
        Self::spawn_with_app(cli, doc_id, workspace, home, port, None)
    }

    pub(crate) fn spawn_with_app(
        cli: &Path,
        doc_id: &str,
        workspace: &Path,
        home: &Path,
        port: Option<u16>,
        app_dir: Option<&Path>,
    ) -> Result<Self, SuperviseError> {
        Self::spawn_inner(
            cli,
            doc_id,
            workspace,
            home,
            port,
            app_dir,
            SpawnTimeouts {
                envelope: ENVELOPE_TIMEOUT,
                ready: READY_TIMEOUT,
            },
        )
    }

    /// 两个等待都带超时参数：测试用小超时，生产路径走模块常量。
    pub(crate) fn spawn_inner(
        cli: &Path,
        doc_id: &str,
        workspace: &Path,
        home: &Path,
        port: Option<u16>,
        app_dir: Option<&Path>,
        timeouts: SpawnTimeouts,
    ) -> Result<Self, SuperviseError> {
        let mut command = cli_command(cli);
        command.args(serve_args(doc_id, workspace, home, port));
        if let Some(dir) = app_dir {
            command.arg("--app-dir").arg(dir);
        }
        command
            // 子进程的 cwd 就是 workspace：`hr serve` 按 cwd 解析相对文档名，不这样传就会误判越界。
            .current_dir(workspace)
            .env("PATH", enriched_path_env())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|error| SuperviseError::CannotSpawn(format!("{cli:?}: {error}")))?;
        let pid = child.id();

        // 信封/就绪任一失败都要先收尸：`Child` 的 Drop 不会 kill，否则失败一次就漏一个 daemon。
        let info = match read_envelope(&mut child, pid, timeouts.envelope).and_then(|info| {
            wait_ready(&info, timeouts.ready)?;
            Ok(info)
        }) {
            Ok(info) => info,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };

        let mut registry = ChildRegistry::default();
        registry.own(pid);
        Ok(Self {
            info,
            child: Some(child),
            registry,
        })
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if !self.registry.should_kill(child.id()) {
            return;
        }
        #[cfg(unix)]
        {
            // 先礼后兵：SIGTERM 让 core 自己删 daemon.json，2s 不退再 SIGKILL。
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(child.id().to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(READY_INTERVAL);
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// `hr serve --json` 把 `{"ok":true,"data":{port,token,pid,workspace}}` 打在 stdout 第一行
/// （`packages/cli/src/output.ts:dataServe`）；token 只留在这份结构里，绝不打印。
///
/// 第一行的读取必须同时有界有时限：坏 CLI 不打换行/不停吐字节不能让壳无限缓冲，
/// 一个字节都不写也不能让壳死等。
fn read_envelope(
    child: &mut Child,
    pid: u32,
    timeout: Duration,
) -> Result<DaemonInfo, SuperviseError> {
    let stdout = child.stdout.take().ok_or(SuperviseError::NoEnvelope)?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, ()>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let result = loop {
            if buf.contains(&b'\n') || buf.len() > ENVELOPE_MAX_BYTES {
                break Ok(buf);
            }
            match reader.read(&mut chunk) {
                Ok(0) => break Ok(buf),
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => break Err(()),
            }
        };
        let _ = tx.send(result);
        // 信封之后 stdout 剩下的内容（正常为空）排空到 sink，防子进程写满管道卡死；零内存代价。
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let buf = match rx.recv_timeout(timeout) {
        Ok(Ok(buf)) => buf,
        Ok(Err(())) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            return Err(SuperviseError::NoEnvelope)
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            return Err(SuperviseError::EnvelopeTimeout)
        }
    };
    let end = buf
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|at| at + 1)
        .unwrap_or(buf.len());
    if buf.is_empty() {
        return Err(SuperviseError::NoEnvelope);
    }
    if end == buf.len() && buf.len() > ENVELOPE_MAX_BYTES {
        // 有界缓冲内没等到换行：这不是合法信封。
        return Err(SuperviseError::BadEnvelope);
    }
    let line = String::from_utf8_lossy(&buf[..end]);
    let parsed: ServeEnvelope =
        serde_json::from_str(line.trim()).map_err(|_| SuperviseError::BadEnvelope)?;
    if parsed.ok != Some(true) {
        let code = parsed.code.unwrap_or_else(|| "unknown".to_string());
        return Err(SuperviseError::Rejected(code));
    }
    let payload = parsed
        .data
        .and_then(MaybeData::valid)
        .ok_or(SuperviseError::BadEnvelope)?;
    if payload.token.is_empty() {
        return Err(SuperviseError::BadEnvelope);
    }
    Ok(DaemonInfo {
        port: payload.port.get(),
        token: payload.token,
        pid,
        workspace: payload.workspace,
    })
}

/// `hr serve` 的参数表：抽成纯函数，参数增减（比如 `--exit-with-parent`）才能被单测钉住。
///
/// `--exit-with-parent` 只给**自己拉起的** daemon 加（`adopted` 没有 child，也就不走这里）：
/// 别人手动跑的 `hr serve` 不是我们的子进程，它的父进程消失不该等于它该关。
/// 传给 `--home` 的一定是壳自己的 app data 目录（不是 `$HOME`），否则会覆写用户那份 `daemon.json`。
fn serve_args(doc_id: &str, workspace: &Path, home: &Path, port: Option<u16>) -> Vec<String> {
    vec![
        "serve".to_string(),
        doc_id.to_string(),
        "--workspace".to_string(),
        workspace.to_string_lossy().into_owned(),
        "--home".to_string(),
        home.to_string_lossy().into_owned(),
        "--json".to_string(),
        "--exit-with-parent".to_string(),
        "--port".to_string(),
        port.unwrap_or(0).to_string(),
    ]
}

fn wait_ready(info: &DaemonInfo, timeout: Duration) -> Result<(), SuperviseError> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(Instant::now);
    while Instant::now() < deadline {
        if SystemProbe.health_pid(info.port) == Some(info.pid) {
            return Ok(());
        }
        std::thread::sleep(READY_INTERVAL);
    }
    Err(SuperviseError::NotReady(info.port))
}

/// 查找内置的 `@hreader/app/dist` 静态产物目录（用于启用完整排版界面）。
pub fn default_app_dir() -> Option<PathBuf> {
    if let Some(from_env) = std::env::var_os("HREADER_APP_DIR") {
        let path = PathBuf::from(from_env);
        if path.join("index.html").is_file() {
            return Some(path);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for rel in [
                "../Resources/resources/app",
                "../Resources/app",
                "resources/app",
            ] {
                let bundled = exe_dir.join(rel);
                if bundled.join("index.html").is_file() {
                    return Some(bundled);
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    for sys_dir in [
        "/usr/lib/hReader/resources/app",
        "/usr/lib/hreader-desktop/resources/app",
    ] {
        let candidate = Path::new(sys_dir);
        if candidate.join("index.html").is_file() {
            return Some(candidate.to_path_buf());
        }
    }
    let repo_app = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/dist");
    if repo_app.join("index.html").is_file() {
        return repo_app.canonicalize().ok().or(Some(repo_app));
    }
    None
}

/// 补全桌面壳通过 Finder / Start Menu / AppImage 启动时常见的 Node 安装路径。
pub fn enriched_path_env() -> OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|raw| std::env::split_paths(&raw).collect())
        .unwrap_or_default();
    #[cfg(unix)]
    {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            let nvm_dir = home.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                let mut versions: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path().join("bin"))
                    .filter(|p| p.is_dir())
                    .collect();
                versions.sort();
                versions.reverse();
                dirs.extend(versions);
            }
            for rel in [".fnm/aliases/default/bin", ".volta/bin"] {
                let candidate = home.join(rel);
                if candidate.is_dir() {
                    dirs.push(candidate);
                }
            }
        }
        for fixed in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            let path = PathBuf::from(fixed);
            if !dirs.contains(&path) {
                dirs.push(path);
            }
        }
    }
    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Some(root) = std::env::var_os(var) {
                let candidate = PathBuf::from(root).join("nodejs");
                if candidate.is_dir() && !dirs.contains(&candidate) {
                    dirs.push(candidate);
                }
            }
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let candidate = PathBuf::from(appdata).join("npm");
            if candidate.is_dir() && !dirs.contains(&candidate) {
                dirs.push(candidate);
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let candidate = PathBuf::from(local).join("Programs/nodejs");
            if candidate.is_dir() && !dirs.contains(&candidate) {
                dirs.push(candidate);
            }
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// 同步执行一条短 CLI 子命令（`style` / `pdf` / `png` / `export` / `template`）。
/// `&[impl AsRef<str>]` 同时吃 `&["a","b"]` 字面量与 `Vec<String>`（动态拼的 argv）。
pub fn run_cli_task(
    cli: &Path,
    workspace: &Path,
    args: &[impl AsRef<str>],
) -> Result<String, String> {
    let output = cli_command(cli)
        .args(args.iter().map(|arg| arg.as_ref()))
        .current_dir(workspace)
        .env("PATH", enriched_path_env())
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法执行 CLI：{error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if !stderr.is_empty() { stderr } else { stdout })
}

/// 停止壳自己的旧 daemon（工作区切换或重建会话时使用）。
pub fn stop_pid(pid: u32) {
    #[cfg(unix)]
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_daemon_is_started_with_exit_with_parent() {
        let args = serve_args("doc.html", Path::new("/ws"), Path::new("/appdata"), None);
        assert!(
            args.iter().any(|arg| arg == "--exit-with-parent"),
            "自己拉起的 daemon 必须看着壳：{args:?}"
        );
        assert_eq!(args.first().map(String::as_str), Some("serve"));
        assert_eq!(args[1], "doc.html");
        let port = args.iter().position(|arg| arg == "--port").expect("--port");
        assert_eq!(args[port + 1], "0", "未指定端口时必须显式传 0（让系统挑）");
    }

    #[test]
    fn home_argument_is_the_shell_home_not_a_guess() {
        let args = serve_args(
            "doc.html",
            Path::new("/ws"),
            Path::new("/appdata"),
            Some(8123),
        );
        let home = args.iter().position(|arg| arg == "--home").expect("--home");
        assert_eq!(args[home + 1], "/appdata");
        assert_eq!(args.iter().filter(|arg| *arg == "--home").count(), 1);
        let port = args.iter().position(|arg| arg == "--port").expect("--port");
        assert_eq!(args[port + 1], "8123");
    }

    #[test]
    fn cli_command_wraps_js_scripts_with_node() {
        for ext in ["mjs", "js", "cjs", "MJS", "JS", "CJS"] {
            let mjs = cli_command(Path::new(&format!("/tmp/cli.{ext}")));
            assert_eq!(mjs.get_program(), "node", "{ext} 必须经 node 启动");
        }

        let native = cli_command(Path::new("/usr/local/bin/hr"));
        assert_eq!(native.get_program(), "/usr/local/bin/hr");
        assert_eq!(native.get_args().count(), 0);
    }

    /// 假 `hr`：一个只走 stdout 的 shell 脚本。下列用例只在 unix 上成立。
    #[cfg(unix)]
    mod fake_cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        struct Fixture {
            root: PathBuf,
            cli: PathBuf,
            ws: PathBuf,
            home: PathBuf,
        }

        impl Fixture {
            fn new(tag: &str, script: &str) -> Self {
                let root =
                    std::env::temp_dir().join(format!("hr-spawn-{tag}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&root);
                let ws = root.join("ws");
                let home = root.join("home");
                std::fs::create_dir_all(&ws).expect("ws");
                std::fs::create_dir_all(&home).expect("home");
                let cli = root.join("fake-hr");
                std::fs::write(&cli, format!("#!/bin/sh\n{script}")).expect("fake cli");
                std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755))
                    .expect("chmod");
                Self {
                    root,
                    cli,
                    ws,
                    home,
                }
            }

            fn spawn(&self, envelope_ms: u64, ready_ms: u64) -> Result<Daemon, SuperviseError> {
                Daemon::spawn_inner(
                    &self.cli,
                    "doc.html",
                    &self.ws,
                    &self.home,
                    Some(1),
                    None,
                    SpawnTimeouts {
                        envelope: Duration::from_millis(envelope_ms),
                        ready: Duration::from_millis(ready_ms),
                    },
                )
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }

        #[test]
        fn a_daemon_that_never_prints_is_reaped_after_the_envelope_timeout() {
            // `sleep 60` 一个字节都不写：信封读取必须带超时，否则壳永远卡在启动。
            let fixture = Fixture::new("hang", "sleep 60\n");
            let error = fixture
                .spawn(400, 100)
                .err()
                .expect("不写信封的 daemon 必须超时报错");
            assert!(
                matches!(error, SuperviseError::EnvelopeTimeout),
                "{error:?}"
            );
        }

        #[test]
        fn a_daemon_that_exits_silently_is_no_envelope() {
            let fixture = Fixture::new("silent", "exit 3\n");
            let error = fixture.spawn(2000, 100).err().expect("静默退出必须报错");
            assert!(matches!(error, SuperviseError::NoEnvelope), "{error:?}");
        }

        #[test]
        fn an_endless_first_line_is_bounded_not_slurped() {
            // 不打换行的无限输出：旧 `read_line` 会无限缓冲。有界读取必须尽快判定。
            let fixture = Fixture::new(
                "flood",
                "while :; do printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; done\n",
            );
            let error = fixture
                .spawn(8000, 100)
                .err()
                .expect("无换行的洪流必须判坏");
            assert!(
                matches!(
                    error,
                    SuperviseError::BadEnvelope | SuperviseError::NoEnvelope
                ),
                "{error:?}"
            );
        }

        #[test]
        fn a_daemon_that_never_serves_is_reported_not_ready() {
            // 信封给了端口但端口一直没人听：wait_ready 必须在自己的超时内收口。
            let fixture = Fixture::new(
                "noready",
                "printf '%s\\n' '{\"ok\":true,\"data\":{\"port\":1,\"token\":\"t\",\"workspace\":\"/ws\"}}'\nsleep 60\n",
            );
            let error = fixture.spawn(2000, 300).err().expect("不就绪必须报错");
            assert!(matches!(error, SuperviseError::NotReady(1)), "{error:?}");
        }
    }
}
