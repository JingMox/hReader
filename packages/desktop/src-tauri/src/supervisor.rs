//! 平台副作用层：探活用的真实 syscall、拉起 `hr`、读它的启动信封、退出时收尸。
//! 判断逻辑在 `spawn_decision`/`child_registry`，这里只负责"真的去做"。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::child_registry::ChildRegistry;
use crate::daemon_file::DaemonInfo;
use crate::spawn_decision::Probe;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const READY_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug)]
pub enum SuperviseError {
    CannotSpawn(String),
    NoEnvelope,
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
        Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
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
        let parsed: Value = serde_json::from_str(body).ok()?;
        if parsed.get("ok")?.as_bool()? {
            u32::try_from(parsed.get("pid")?.as_u64()?).ok()
        } else {
            None
        }
    }
}

fn address(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}

/// 壳持有的一段 daemon 关系。`child` 为 `None` 表示复用文件里已有的 daemon（不是壳的孩子）。
pub struct Daemon {
    info: DaemonInfo,
    child: Option<Child>,
    registry: ChildRegistry,
}

impl Daemon {
    pub fn info(&self) -> &DaemonInfo {
        &self.info
    }

    /// 复用别人起的 daemon：只记账为外部，退出时绝不 kill（AC-15）。
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
    /// 且必须先把 `SignalSubscription` 交给 `connect_with`——这一层是 M2 类型闸要守住的那道门。
    pub(crate) fn spawn(
        cli: &Path,
        doc_id: &str,
        workspace: &Path,
        home: &Path,
        port: Option<u16>,
    ) -> Result<Self, SuperviseError> {
        let mut command = Command::new(cli);
        command
            .args(serve_args(doc_id, workspace, home, port))
            // 子进程的 cwd 就是 workspace：`hr serve` 按 cwd 解析相对文档名，不这样传就会误判越界。
            .current_dir(workspace)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|error| SuperviseError::CannotSpawn(format!("{cli:?}: {error}")))?;
        let pid = child.id();

        // 信封/就绪任一失败都要先收尸：`Child` 的 Drop 不会 kill，否则失败一次就漏一个 daemon。
        let info = match read_envelope(&mut child, pid).and_then(|info| {
            wait_ready(&info)?;
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
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// `hr serve --json` 把 `{"ok":true,"data":{port,token,pid,workspace}}` 打在 stdout 第一行
/// （`packages/cli/src/output.ts:dataServe`）；token 只留在这份结构里，绝不打印。
fn read_envelope(child: &mut Child, pid: u32) -> Result<DaemonInfo, SuperviseError> {
    let stdout = child.stdout.take().ok_or(SuperviseError::NoEnvelope)?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let read = reader
        .read_line(&mut line)
        .map_err(|_| SuperviseError::NoEnvelope)?;
    if read == 0 {
        return Err(SuperviseError::NoEnvelope);
    }
    let parsed: Value =
        serde_json::from_str(line.trim()).map_err(|_| SuperviseError::BadEnvelope)?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let code = parsed
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(SuperviseError::Rejected(code.to_string()));
    }
    let payload = parsed.get("data").ok_or(SuperviseError::BadEnvelope)?;
    let port = payload
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value != 0)
        .ok_or(SuperviseError::BadEnvelope)?;
    let token = payload
        .get("token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(SuperviseError::BadEnvelope)?;
    let workspace = payload
        .get("workspace")
        .and_then(Value::as_str)
        .ok_or(SuperviseError::BadEnvelope)?;
    // stdout 剩下的内容（正常为空）由后台线程清空，避免子进程写满管道后卡死；内容一律丢弃。
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = reader.read_to_end(&mut sink);
    });
    Ok(DaemonInfo {
        port,
        token: token.to_string(),
        pid,
        workspace: workspace.into(),
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

fn wait_ready(info: &DaemonInfo) -> Result<(), SuperviseError> {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if SystemProbe.health_pid(info.port) == Some(info.pid) {
            return Ok(());
        }
        std::thread::sleep(READY_INTERVAL);
    }
    Err(SuperviseError::NotReady(info.port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ac14_own_daemon_is_started_with_exit_with_parent() {
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
    fn ac11_home_argument_is_the_shell_home_not_a_guess() {
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
}
