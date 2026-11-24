//! 导航前的复核（TOCTOU）：`decide` 说"复用"之后端口被抢走，壳必须拒绝导航。
//!
//! 这一层测的是**接线**：`connect_with` 真的调了 `spawn_decision::recheck`。
//! 只测 `recheck` 本身抓不到"`connect` 里忘了调它"这种变异（`decide` 之后直接拼 URL）。

use std::cell::Cell;
use std::fs;
use std::path::PathBuf;

use hreader_desktop::options::ShellOptions;
use hreader_desktop::spawn_decision::{Conflict, Probe};
use hreader_desktop::{connect_with, StartupError};

/// 按阶段变化的探针：第一次探测（`decide`）用 steps[0]，之后的探测（导航前的复核）用 steps[1]。
/// `decide` 与 `recheck` 都以 `port_open` 开步，所以用"已开过的轮数"当阶段号。
struct Scripted {
    steps: Vec<(bool, bool, Option<u32>)>,
    /// 已经开了几轮探测（`decide` 一轮、导航前复核一轮）。
    rounds: Cell<usize>,
    /// 本轮用的阶段号：由本轮的 `port_open` 定下，轮内三个方法共用同一份现场。
    at: Cell<usize>,
}

impl Scripted {
    fn new(steps: &[(bool, bool, Option<u32>)]) -> Self {
        Self {
            steps: steps.to_vec(),
            rounds: Cell::new(0),
            at: Cell::new(0),
        }
    }

    fn current(&self) -> (bool, bool, Option<u32>) {
        self.steps[self.at.get().min(self.steps.len() - 1)]
    }
}

impl Probe for Scripted {
    fn port_open(&self, _port: u16) -> bool {
        self.at.set(self.rounds.get());
        self.rounds.set(self.rounds.get() + 1);
        self.current().0
    }

    fn process_alive(&self, _pid: u32) -> bool {
        self.current().1
    }

    fn health_pid(&self, _port: u16) -> Option<u32> {
        self.current().2
    }
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("hr-desktop-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("home/.hreader")).expect("建 home");
        fs::create_dir_all(root.join("ws")).expect("建 workspace");
        fs::write(
            root.join("ws/doc.html"),
            "<article data-hr-id=\"a\">x</article>",
        )
        .expect("写文档");
        fs::write(root.join("fake-hr"), "#!/bin/sh\n").expect("写假 CLI");
        fs::write(
            root.join("home/.hreader/daemon.json"),
            format!(
                "{{\"port\":8123,\"token\":\"tok\",\"pid\":42,\"workspace\":{:?}}}",
                root.join("ws").to_string_lossy()
            ),
        )
        .expect("写 daemon.json");
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

    fn argv(&self) -> Vec<String> {
        vec![
            "--open".to_string(),
            self.root.join("ws/doc.html").to_string_lossy().into_owned(),
        ]
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn conflict_of(error: StartupError) -> Conflict {
    match error {
        StartupError::Conflict(conflict) => conflict,
        other => panic!("期望冲突，实际是 {other:?}"),
    }
}

#[test]
fn navigation_is_refused_when_the_port_changes_hands_before_it() {
    let fixture = Fixture::new("recheck");
    // 第一轮（`decide`）是自己，第二轮（导航前的复核）已经被换手。
    // 拒绝 = 没有 Session = 没有 webview 导航，抢到端口的人也就收不到那个带 `?t=` 的首个请求。
    let probe = Scripted::new(&[(true, true, Some(42)), (true, true, Some(7))]);
    let Err(error) = connect_with(
        &fixture.argv(),
        &fixture.options(),
        &probe,
        hreader_desktop::signals::watch(),
    ) else {
        panic!("TOCTOU 复核没过却放行了导航");
    };
    assert_eq!(conflict_of(error), Conflict::NotAnHreaderDaemon);
    assert_eq!(probe.rounds.get(), 2, "复核那一轮必须真的跑过");
}

#[test]
fn navigation_happens_when_the_same_daemon_still_answers() {
    let fixture = Fixture::new("recheck-ok");
    let probe = Scripted::new(&[(true, true, Some(42))]);
    let session = connect_with(
        &fixture.argv(),
        &fixture.options(),
        &probe,
        hreader_desktop::signals::watch(),
    )
    .expect("应当放行");
    assert!(session.url.contains("?t=tok"), "{}", session.url);
    assert_eq!(probe.rounds.get(), 2, "放行也是复核一轮之后才拼 URL");
    session.daemon.reap();
}

#[test]
fn navigation_is_refused_when_the_daemon_died_before_it() {
    let fixture = Fixture::new("recheck-gone");
    let probe = Scripted::new(&[(true, true, Some(42)), (false, false, None)]);
    let Err(error) = connect_with(
        &fixture.argv(),
        &fixture.options(),
        &probe,
        hreader_desktop::signals::watch(),
    ) else {
        panic!("daemon 已经死了却还放行导航");
    };
    assert!(
        matches!(error, StartupError::DaemonGone),
        "端口都不通了：{error:?}"
    );
}
