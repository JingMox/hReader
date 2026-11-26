//! `--smoke`：无窗口跑一遍真实链路，三层证据各打一行 JSON 字段（stdout 只有一行，token 已脱敏）。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde::Serialize;

use crate::daemon_file;
use crate::options::ShellOptions;
use crate::redact;
use crate::spawn_decision::{decide, Decision};
use crate::supervisor::{Daemon, SystemProbe};
use crate::{document_of, startup_message};

const IO_TIMEOUT: Duration = Duration::from_secs(3);

pub fn run(argv: &[String], options: &ShellOptions) -> i32 {
    match probe(argv, options) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(message) => {
            eprintln!("smoke 失败：{message}");
            1
        }
    }
}

fn probe(argv: &[String], options: &ShellOptions) -> Result<String, String> {
    let action = crate::open_arg::action_of(argv, &options.workspace)
        .map_err(|error| startup_message(&crate::StartupError::Open(error)))?;
    let doc_id =
        document_of(&action, &options.workspace).map_err(|error| startup_message(&error))?;
    // 与 GUI 共用同一条定位链：--cli-path / HREADER_CLI / PATH / 内置资源，少一处分叉。
    let cli = crate::locate_cli(options).map_err(|error| startup_message(&error))?;

    let state = daemon_file::read_daemon(&daemon_file::daemon_file_in(&options.home))
        .map_err(|error| startup_message(&crate::StartupError::DaemonFile(error)))?;
    let daemon = match decide(&state, &SystemProbe) {
        Decision::Reuse(info) => Daemon::adopted(info),
        Decision::Conflicted(conflict) => {
            return Err(startup_message(&crate::StartupError::Conflict(conflict)))
        }
        Decision::Spawn { .. } => Daemon::spawn(
            &cli,
            &doc_id,
            &options.workspace,
            &options.home,
            options.port,
        )
        .map_err(|error| startup_message(&crate::StartupError::Supervise(error)))?,
    };

    let info = daemon.info();
    // 第一层：端口有人在听，且 `/healthz` 回的 pid 就是刚记的 pid（不是别的进程）。
    let health = http_get(info.port, "/healthz", None).ok_or("healthz 不通")?;
    if health.status != 200 || !health.body.contains(&format!("\"pid\":{}", info.pid)) {
        return Err(format!(
            "healthz 回包不是这个 daemon（status {}）",
            health.status
        ));
    }

    // 第二层：`/s/<docId>?t=<token>` 必须 302 到 `/` 并下发 cookie——这是 bootstrap 唯一正道。
    let nav = crate::url_build::bootstrap_url(info.port, &doc_id, &info.token)
        .map_err(|error| format!("bootstrap URL 拼不出来：{error}"))?;
    let path = nav
        .split_once("://")
        .and_then(|(_, rest)| rest.find('/').map(|at| &rest[at..]))
        .ok_or("nav 不是 http URL")?;
    let bootstrap = http_get(info.port, path, None).ok_or("bootstrap 不通")?;
    let cookie = bootstrap
        .cookie
        .as_deref()
        .ok_or_else(|| format!("bootstrap 没下发 cookie（status {}）", bootstrap.status))?;

    // 第三层：拿着 cookie 取文档页，正文非空——证明认证真的过了、文档真的在那儿。
    let document = http_get(info.port, "/", Some(cookie)).ok_or("文档页不通")?;
    if document.status != 200 || !document.body.contains("<") {
        return Err(format!("文档页没拿到（status {}）", document.status));
    }

    let report = SmokeReport {
        ok: true,
        checks: ["healthz", "bootstrap-cookie", "document"],
        port: info.port,
        pid: info.pid,
        nav: redact::redact(&nav, &info.token),
        document_bytes: document.body.len(),
    };
    serde_json::to_string(&report).map_err(|error| format!("smoke 输出序列化失败：{error}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeReport {
    ok: bool,
    checks: [&'static str; 3],
    port: u16,
    pid: u32,
    nav: String,
    document_bytes: usize,
}

struct Response {
    status: u16,
    cookie: Option<String>,
    body: String,
}

fn http_get(port: u16, path: &str, cookie: Option<&str>) -> Option<Response> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, IO_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    let cookie_header = cookie
        .map(|value| format!("cookie: {value}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "GET {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\n{cookie_header}connection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    let (head, body) = raw.split_once("\r\n\r\n")?;
    let mut lines = head.lines();
    let status = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let cookie = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("set-cookie").then(|| {
            value
                .trim()
                .split(';')
                .next()
                .unwrap_or_default()
                .to_string()
        })
    });
    Some(Response {
        status,
        cookie,
        body: body.to_string(),
    })
}
