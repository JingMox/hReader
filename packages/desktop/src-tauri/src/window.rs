//! 平台壳：唯一创建窗口、注册全局快捷键的地方；装配逻辑都在 `connect`。

use std::str::FromStr;

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::shortcut::{self, Accel, Modifier};
use crate::signals;

pub fn run(url: String, session: crate::Session) -> i32 {
    let Ok(parsed) = url.parse::<tauri::Url>() else {
        eprintln!("webview 地址不合法");
        session.daemon.reap();
        return 1;
    };
    let accels = match shortcut::default_accels() {
        Ok(accels) => accels,
        Err(error) => {
            eprintln!("accels.json 有误：{error:?}");
            session.daemon.reap();
            return 1;
        }
    };
    let reaper = session.daemon.clone();
    let setup_reaper = reaper.clone();

    let outcome = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(parsed))
                .title("hReader")
                .inner_size(1120.0, 820.0)
                .build()?;
            register(app.handle(), &accels)?;
            // 关窗口 ≠ 退出：SIGTERM/SIGINT 也必须走到收尸，否则壳拉起的 daemon 会漏下来占端口。
            signals::watch();
            let handle = app.handle().clone();
            let stop_reaper = setup_reaper.clone();
            signals::on_stop(move || {
                stop_reaper.reap();
                handle.exit(0);
            });
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match outcome {
        Ok(app) => app,
        Err(error) => {
            eprintln!("窗口起不来：{error}");
            reaper.reap();
            return 1;
        }
    };
    // GUI 正常退出的收尸点：`app.exit()`（信号路径）与"最后一个窗口关了"都会走到这里。
    let exit_reaper = reaper.clone();
    app.run(move |_app, event| {
        if exits(&event) {
            exit_reaper.reap();
        }
    });
    reaper.reap();
    0
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
