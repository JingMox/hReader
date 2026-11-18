//! "该不该我拉起 daemon"的纯决策：四态各有唯一结果。
//!
//! 探测能力由 `Probe` 注入——单测用假实现，真实现（TCP / `kill -0` / `GET /healthz`）在
//! `supervisor.rs`。把探测与决策分开，是为了让"端口被别人占着"这种真机上难造的现场可单测。

use crate::daemon_file::{DaemonInfo, DaemonState};

pub trait Probe {
    fn port_open(&self, port: u16) -> bool;
    fn process_alive(&self, pid: u32) -> bool;
    /// `/healthz` 回包里的 pid（不是 hReader 或连不上时 `None`）。
    /// 拿 pid 而不只拿"活"：端口被别的进程听着时，回包 pid 与文件里的 pid 对不上，这正是第三态的判据。
    fn health_pid(&self, port: u16) -> Option<u32>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// 文件指向的 daemon 活着且健康：复用，不重复拉起（也绝不 kill）。
    Reuse(DaemonInfo),
    /// 该我拉起；`stale` 表示文件里是一份死残留，要先清掉。
    Spawn { stale: bool },
    /// 端口上不是 hReader 的 daemon：既不 kill 也不覆盖，报错退出。
    Conflicted(Conflict),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    /// 文件里的 pid 已死，端口却有人听。
    PortOwnedByOther,
    /// 文件里的 pid 活着，但 `/healthz` 不是 hReader 的回包。
    NotAnHreaderDaemon,
}

impl Conflict {
    /// 人读文案的 key（翻译在呈现层，断言文案时查 key 而不是拼好的句子）。
    pub fn message_key(self) -> &'static str {
        match self {
            Conflict::PortOwnedByOther => "port_taken",
            Conflict::NotAnHreaderDaemon => "daemon_unrecognized",
        }
    }
}

pub fn decide(state: &DaemonState, probe: &dyn Probe) -> Decision {
    match state {
        DaemonState::Absent => Decision::Spawn { stale: false },
        DaemonState::Present(info) => present(info, probe),
    }
}

/// 导航前的复核结论：`decide` 说"复用"之后、真的去 `connect` 之前，端口可能已经被别人抢走；
/// 抢到的那个人会收到带 `?t=` 的首个请求（等于偷 token）。所以只有"还是原来那个 hReader"才放行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecheckError {
    Conflicted(Conflict),
    /// 复核时连端口都不通了：daemon 在我们准备导航前退出了。
    Gone,
}

pub fn recheck(info: &DaemonInfo, probe: &dyn Probe) -> Result<(), RecheckError> {
    match decide(&DaemonState::Present(info.clone()), probe) {
        Decision::Reuse(_) => Ok(()),
        Decision::Conflicted(conflict) => Err(RecheckError::Conflicted(conflict)),
        Decision::Spawn { .. } => Err(RecheckError::Gone),
    }
}

fn present(info: &DaemonInfo, probe: &dyn Probe) -> Decision {
    if !probe.port_open(info.port) {
        return Decision::Spawn { stale: true };
    }
    match probe.health_pid(info.port) {
        Some(pid) if pid == info.pid => Decision::Reuse(info.clone()),
        Some(_) => Decision::Conflicted(Conflict::NotAnHreaderDaemon),
        None if probe.process_alive(info.pid) => Decision::Conflicted(Conflict::NotAnHreaderDaemon),
        None => Decision::Conflicted(Conflict::PortOwnedByOther),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fake {
        port_open: bool,
        pid_alive: bool,
        health_pid: Option<u32>,
    }

    impl Probe for Fake {
        fn port_open(&self, _port: u16) -> bool {
            self.port_open
        }
        fn process_alive(&self, _pid: u32) -> bool {
            self.pid_alive
        }
        fn health_pid(&self, _port: u16) -> Option<u32> {
            self.health_pid
        }
    }

    fn info() -> DaemonInfo {
        DaemonInfo {
            port: 8123,
            token: "tok".to_string(),
            pid: 42,
            workspace: PathBuf::from("/ws"),
        }
    }

    fn probe(port_open: bool, pid_alive: bool, health_pid: Option<u32>) -> Fake {
        Fake {
            port_open,
            pid_alive,
            health_pid,
        }
    }

    fn state() -> DaemonState {
        DaemonState::Present(info())
    }

    #[test]
    fn ac4_absent_file_means_spawn_without_stale_cleanup() {
        assert_eq!(
            decide(&DaemonState::Absent, &probe(true, true, Some(42))),
            Decision::Spawn { stale: false }
        );
    }

    #[test]
    fn ac4_dead_port_means_spawn_after_cleaning_the_residue() {
        assert_eq!(
            decide(&state(), &probe(false, false, None)),
            Decision::Spawn { stale: true }
        );
    }

    #[test]
    fn ac4_live_healthy_daemon_is_reused() {
        assert_eq!(
            decide(&state(), &probe(true, true, Some(42))),
            Decision::Reuse(info())
        );
    }

    #[test]
    fn ac4_port_open_with_dead_pid_is_conflicted() {
        assert_eq!(
            decide(&state(), &probe(true, false, None)),
            Decision::Conflicted(Conflict::PortOwnedByOther)
        );
        // 端口有人听、回包却是别人的 pid：同属"不是我的 daemon"。
        assert_eq!(
            decide(&state(), &probe(true, false, Some(7))),
            Decision::Conflicted(Conflict::NotAnHreaderDaemon)
        );
    }

    #[test]
    fn ac4_port_open_pid_alive_but_health_fails_is_conflicted() {
        assert_eq!(
            decide(&state(), &probe(true, true, None)),
            Decision::Conflicted(Conflict::NotAnHreaderDaemon)
        );
    }

    #[test]
    fn ac4_conflict_keys_are_stable() {
        assert_eq!(Conflict::PortOwnedByOther.message_key(), "port_taken");
        assert_eq!(
            Conflict::NotAnHreaderDaemon.message_key(),
            "daemon_unrecognized"
        );
    }

    /// 逐次变化的探针：`decide` 时还是自己，`advance` 之后（= 真去导航之前）已经被换手。
    struct Scripted {
        steps: Vec<(bool, bool, Option<u32>)>,
        at: std::cell::Cell<usize>,
    }

    impl Scripted {
        fn new(steps: &[(bool, bool, Option<u32>)]) -> Self {
            Self {
                steps: steps.to_vec(),
                at: std::cell::Cell::new(0),
            }
        }

        fn current(&self) -> (bool, bool, Option<u32>) {
            self.steps[self.at.get().min(self.steps.len() - 1)]
        }

        fn advance(&self) {
            self.at.set(self.at.get() + 1);
        }
    }

    impl Probe for Scripted {
        fn port_open(&self, _port: u16) -> bool {
            self.current().0
        }
        fn process_alive(&self, _pid: u32) -> bool {
            self.current().1
        }
        fn health_pid(&self, _port: u16) -> Option<u32> {
            self.current().2
        }
    }

    #[test]
    fn ac4_recheck_rejects_a_squatter_that_took_the_port_after_reuse() {
        let probe = Scripted::new(&[(true, true, Some(42)), (true, true, Some(7))]);
        assert_eq!(decide(&state(), &probe), Decision::Reuse(info()));
        probe.advance();
        assert_eq!(
            recheck(&info(), &probe),
            Err(RecheckError::Conflicted(Conflict::NotAnHreaderDaemon))
        );
    }

    #[test]
    fn ac4_recheck_rejects_when_health_stops_answering() {
        let probe = Scripted::new(&[(true, true, Some(42)), (true, true, None)]);
        assert_eq!(decide(&state(), &probe), Decision::Reuse(info()));
        probe.advance();
        assert_eq!(
            recheck(&info(), &probe),
            Err(RecheckError::Conflicted(Conflict::NotAnHreaderDaemon))
        );
    }

    #[test]
    fn ac4_recheck_reports_a_daemon_that_died_before_navigation() {
        let probe = Scripted::new(&[(true, true, Some(42)), (false, false, None)]);
        assert_eq!(decide(&state(), &probe), Decision::Reuse(info()));
        probe.advance();
        assert_eq!(recheck(&info(), &probe), Err(RecheckError::Gone));
    }

    #[test]
    fn ac4_recheck_passes_when_the_same_daemon_still_answers() {
        let probe = Scripted::new(&[(true, true, Some(42))]);
        assert_eq!(recheck(&info(), &probe), Ok(()));
    }
}
