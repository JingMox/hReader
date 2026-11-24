//! 文档级失败的接线：`hr serve` 的拒收信封必须穿过 `connect_with` 变成
//! `StartupError::Supervise(Rejected(code))`——window.rs 靠这个类型把失败降级到"这一份
//! 文档"（正文区提示 + 文件树可用），而不是让整个工作区起不来。
//!
//! 假 `hr` 是一个只打印拒收信封的 shell 脚本，所以本测试只在 unix 上跑。

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use hreader_desktop::options::ShellOptions;
use hreader_desktop::spawn_decision::Probe;
use hreader_desktop::supervisor::SuperviseError;
use hreader_desktop::{connect_with, StartupError};

/// `Decision::Absent` 时 `decide` 不会探任何一针：探针存在只为满足签名。
struct NeverProbed;

impl Probe for NeverProbed {
    fn port_open(&self, _port: u16) -> bool {
        panic!("Absent 分支不该探测端口")
    }

    fn process_alive(&self, _pid: u32) -> bool {
        panic!("Absent 分支不该探测进程")
    }

    fn health_pid(&self, _port: u16) -> Option<u32> {
        panic!("Absent 分支不该探测 healthz")
    }
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    /// workspace 里一份外来文档 + 一个打印 `{"ok":false,"code":...}` 就退出的假 `hr`。
    fn new(tag: &str, envelope: &str) -> Self {
        let root = std::env::temp_dir().join(format!("hr-desktop-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("home")).expect("建 home");
        fs::create_dir_all(root.join("ws")).expect("建 workspace");
        fs::write(
            root.join("ws/foreign.html"),
            "<html><body><p>no article</p><script>1</script></body></html>",
        )
        .expect("写文档");
        let fake = root.join("fake-hr");
        fs::write(
            &fake,
            format!("#!/bin/sh\nprintf '%s\\n' '{envelope}'\nexit 2\n"),
        )
        .expect("写假 CLI");
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).expect("加执行位");
        Self { root }
    }

    fn options(&self) -> ShellOptions {
        ShellOptions {
            smoke: false,
            home: self.root.join("home"),
            workspace: self.root.join("ws"),
            cli_path: Some(self.root.join("fake-hr")),
            port: None,
            hold: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn serve_rejection_surfaces_as_supervise_error_with_the_code() {
    let fixture = Fixture::new(
        "rejected",
        "{\"ok\":false,\"code\":\"invalid_document\",\"message\":\"no <article>\"}",
    );
    let Err(error) = connect_with(
        &[],
        &fixture.options(),
        &NeverProbed,
        hreader_desktop::signals::watch(),
    ) else {
        panic!("hr serve 拒收必须让 connect 失败");
    };
    assert!(
        matches!(
            &error,
            StartupError::Supervise(SuperviseError::Rejected(code)) if code == "invalid_document"
        ),
        "拒收码要原样透传，实际：{error:?}"
    );
    assert!(
        error.to_string().contains("invalid_document"),
        "正文区/提示文案要能拿到拒收码：{error}"
    );
}

#[test]
fn serve_envelope_that_is_not_json_is_a_bad_envelope() {
    let fixture = Fixture::new("badenv", "not-json-at-all");
    let Err(error) = connect_with(
        &[],
        &fixture.options(),
        &NeverProbed,
        hreader_desktop::signals::watch(),
    ) else {
        panic!("坏信封必须让 connect 失败");
    };
    assert!(
        matches!(&error, StartupError::Supervise(SuperviseError::BadEnvelope)),
        "非 JSON 首行是 BadEnvelope 而不是 Rejected：{error:?}"
    );
}
