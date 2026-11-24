//! SIGTERM/SIGINT → 优雅收尾。壳被杀时 daemon 也必须有归宿，否则端口被一个没人管的进程永远占着
//! （`Child` 的 Drop 不会替你 kill）。
//!
//! 平台：Unix 使用 `signal-hook` 的安全高层 `flag::register` 接口写入原子标志，真正的收尾交给后台线程；
//! Windows 没有这套机制，走空桩并依赖 `hr serve --exit-with-parent` 的父进程看门狗兜底。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// `watch()` 的产物，也是 `connect_with` 的实参：没有它就调不通连 daemon 的那一步。
///
/// 为什么做成类型而不是靠测试：`watch()` 必须早于 `connect()`——`connect` 里有"已 spawn、还没 own"
/// 的窗口（最长 `READY_TIMEOUT`），那段时间要收尸。把顺序写成类型后，"先 connect 后 watch"直接编译不过。
/// 字段私有：只有本模块的 `watch()`/`watch_with()` 造得出来，外部拿不到一个可伪造的 token。
pub struct SignalSubscription {
    installed: bool,
}

impl SignalSubscription {
    fn new(installed: bool) -> Self {
        Self { installed }
    }

    /// 装没装上要能被断言：`--hold` 的验证不能只靠"应该装上了"。
    pub fn installed(&self) -> bool {
        self.installed
    }
}

/// 平台注册器：把"信号 → 原子标志"交给操作系统；`Err` 表示这次没装上（调用方回滚并告警）。
pub type Registrar = dyn Fn(i32, Arc<AtomicBool>) -> Result<(), String>;

#[cfg(unix)]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, LazyLock};
    use std::time::Duration;

    use signal_hook::consts::signal::{SIGINT, SIGTERM};

    /// 信号收尾的全部可变状态。生产代码用 `GLOBAL` 单例；测试各自造一份独占夹具，
    /// 于是用例之间不再共享状态，也不需要跑完再重置。
    pub(super) struct Hub {
        stopped: Arc<AtomicBool>,
        watched: AtomicBool,
        failed: AtomicBool,
        announced: AtomicBool,
    }

    impl Hub {
        pub(super) fn new() -> Self {
            Self {
                stopped: Arc::new(AtomicBool::new(false)),
                watched: AtomicBool::new(false),
                failed: AtomicBool::new(false),
                announced: AtomicBool::new(false),
            }
        }

        pub fn stopped(&self) -> bool {
            self.stopped.load(Ordering::Relaxed)
        }

        /// 幂等：`run()` 与 `window::run()` 都会调，重复注册只会装一次。
        pub fn watch(&self) -> super::SignalSubscription {
            match self.watch_with(&register) {
                Ok(subscription) => subscription,
                Err(reason) => {
                    // 不阻断启动：没有信号收尾时，退出兜底还有 `--exit-with-parent` 的父进程看门狗。
                    // 只喊一次：失败已经记在 `failed` 上，每个调用点再喊一遍只会把日志刷成噪音。
                    if !self.announced.swap(true, Ordering::SeqCst) {
                        eprintln!(
                            "装不上信号处理器（{reason}）：退出收尾交给 --exit-with-parent 看门狗"
                        );
                    }
                    super::SignalSubscription::new(false)
                }
            }
        }

        /// 装了哪些、装没装上都要能说清楚：注册失败必须回滚，且不再重试——
        /// 回滚 + 重试会让每个调用点各失败一次、各告警一次，而注册器那边并没有"再试就好"的理由。
        pub fn watch_with(
            &self,
            registrar: &super::Registrar,
        ) -> Result<super::SignalSubscription, String> {
            if self.failed.load(Ordering::SeqCst) {
                return Err("信号处理器此前已注册失败，不再重试".to_string());
            }
            if self.watched.swap(true, Ordering::SeqCst) {
                return Ok(super::SignalSubscription::new(true));
            }
            for signal in [SIGTERM, SIGINT] {
                if let Err(reason) = registrar(signal, Arc::clone(&self.stopped)) {
                    self.watched.store(false, Ordering::SeqCst);
                    self.failed.store(true, Ordering::SeqCst);
                    return Err(reason);
                }
            }
            Ok(super::SignalSubscription::new(true))
        }
    }

    impl Default for Hub {
        fn default() -> Self {
            Self::new()
        }
    }

    /// 生产单例：真的接操作系统信号的那一份。
    pub(super) static GLOBAL: LazyLock<Hub> = LazyLock::new(Hub::new);

    const POLL: Duration = Duration::from_millis(50);

    fn register(signal: i32, flag: Arc<AtomicBool>) -> Result<(), String> {
        signal_hook::flag::register(signal, flag)
            .map(|_id| ())
            .map_err(|error| error.to_string())
    }

    pub fn stopped() -> bool {
        GLOBAL.stopped()
    }

    pub fn watch() -> super::SignalSubscription {
        GLOBAL.watch()
    }

    pub fn watch_with(registrar: &super::Registrar) -> Result<super::SignalSubscription, String> {
        GLOBAL.watch_with(registrar)
    }

    /// 收到信号后调一次 `on_stop`（在普通线程里跑，所以可以安全地碰 tauri 事件循环）。
    pub fn on_stop(on_stop: impl FnOnce() + Send + 'static) {
        std::thread::spawn(move || {
            while !stopped() {
                std::thread::sleep(POLL);
            }
            on_stop();
        });
    }

    /// 无窗口模式（`--hold`）：等到信号或超时，返回后调用方的 `Drop` 会收尸。
    pub fn wait_or_timeout(timeout: Duration) {
        let deadline = std::time::Instant::now() + timeout;
        while !stopped() && std::time::Instant::now() < deadline {
            std::thread::sleep(POLL);
        }
    }
}

/// Windows：没有可移植的 SIGTERM 收尾，一律空操作。调用点不需要 `cfg`（签名与 Unix 版一致）。
#[cfg(not(unix))]
mod platform {
    use std::time::Duration;

    /// Windows 上没有信号状态；这个类型只为让测试与 Unix 版共用一套"每用例独占夹具"的写法。
    pub(super) struct Hub;

    impl Hub {
        pub(super) fn new() -> Self {
            Self
        }

        pub fn stopped(&self) -> bool {
            false
        }

        pub fn watch(&self) -> super::SignalSubscription {
            super::SignalSubscription::new(false)
        }

        pub fn watch_with(
            &self,
            _registrar: &super::Registrar,
        ) -> Result<super::SignalSubscription, String> {
            Ok(super::SignalSubscription::new(false))
        }
    }

    impl Default for Hub {
        fn default() -> Self {
            Self::new()
        }
    }

    pub(super) static GLOBAL: Hub = Hub;

    pub fn stopped() -> bool {
        GLOBAL.stopped()
    }

    pub fn watch() -> super::SignalSubscription {
        GLOBAL.watch()
    }

    pub fn watch_with(registrar: &super::Registrar) -> Result<super::SignalSubscription, String> {
        GLOBAL.watch_with(registrar)
    }

    pub fn on_stop(_on_stop: impl FnOnce() + Send + 'static) {}

    /// 只能等超时：Windows 上 `--hold` 的提前退出不存在。
    pub fn wait_or_timeout(timeout: Duration) {
        std::thread::sleep(timeout);
    }
}

pub use platform::{on_stop, stopped, wait_or_timeout, watch, watch_with};

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn ac14_watching_twice_is_idempotent() {
        let hub = platform::Hub::new();
        hub.watch();
        hub.watch();
        assert!(!hub.stopped(), "还没收到信号就报停下");
    }

    #[cfg(unix)]
    #[test]
    fn r3_register_failure_rolls_back_and_is_not_retried() {
        let hub = platform::Hub::new();
        let failing = |_signal: i32, _flag: Arc<AtomicBool>| -> Result<(), String> {
            Err("boom".to_string())
        };
        match hub.watch_with(&failing) {
            Ok(_) => panic!("注册失败必须冒泡"),
            Err(error) => assert!(error.contains("boom"), "原因要原样带出来：{error}"),
        }
        let never = |_signal: i32, _flag: Arc<AtomicBool>| -> Result<(), String> {
            panic!("失败之后不该再碰注册器")
        };
        match hub.watch_with(&never) {
            Ok(_) => panic!("失败之后不该再给出订阅"),
            Err(error) => assert!(error.contains("不再重试"), "要说清是不再重试：{error}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn r3_installed_reports_a_handler_that_is_really_registered() {
        assert!(watch().installed(), "本机应当装得上 SIGTERM/SIGINT");
        let hub = platform::Hub::new();
        let accepting = |_signal: i32, _flag: Arc<AtomicBool>| -> Result<(), String> { Ok(()) };
        assert!(hub.watch_with(&accepting).expect("应当装上").installed());
    }

    #[cfg(unix)]
    #[test]
    fn r1_watch_with_reports_each_signal_it_registers() {
        use signal_hook::consts::signal::{SIGINT, SIGTERM};

        let hub = platform::Hub::new();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let registrar = move |signal: i32, _flag: Arc<AtomicBool>| -> Result<(), String> {
            recorded.lock().expect("锁没中毒").push(signal);
            Ok(())
        };
        hub.watch_with(&registrar).expect("应当装上");
        let mut signals = seen.lock().expect("锁没中毒").clone();
        signals.sort_unstable();
        assert_eq!(signals, vec![SIGINT, SIGTERM]);
    }

    #[test]
    fn ac14_waiting_returns_after_the_timeout() {
        let started = std::time::Instant::now();
        wait_or_timeout(Duration::from_millis(120));
        assert!(started.elapsed() >= Duration::from_millis(120));
    }
}
