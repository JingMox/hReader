//! 壳自己的命令行（不含 `--open`：文档参数由 `open_arg` 单独解释才不把 `--home` 的值当文件）。

use std::path::{Path, PathBuf};

/// 带值 flag 的单一清单：`open_arg` 靠它跳过这些值，否则 `--home /tmp/h` 的 `/tmp/h`
/// 会被当成"双击进来的文档路径"。
pub const VALUE_FLAGS: [&str; 5] = ["--home", "--workspace", "--cli-path", "--port", "--hold"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellOptions {
    pub smoke: bool,
    /// 壳自己的 `HREADER_HOME/.hreader/daemon.json`——必须和 CLI 的默认 home 隔离，
    /// 否则用户另开的 `hr serve` 会被壳当成自己的 daemon 接管。
    pub home: PathBuf,
    pub workspace: PathBuf,
    pub cli_path: Option<PathBuf>,
    pub port: Option<u16>,
    /// `--hold <secs>`：无窗口存活 N 秒（退出清理的可测入口）。
    pub hold: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OptionsError {
    MissingValue(String),
    UnknownFlag(String),
    BadPort(String),
    BadHold(String),
}

impl std::fmt::Display for OptionsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingValue(flag) => write!(formatter, "{flag} 后面要跟一个值"),
            Self::UnknownFlag(flag) => write!(formatter, "不认识的参数 {flag}"),
            Self::BadPort(raw) => write!(formatter, "--port 必须是 1..65535 的整数（收到 {raw}）"),
            Self::BadHold(raw) => write!(formatter, "--hold 必须是秒数（收到 {raw}）"),
        }
    }
}

/// `argv` 不含程序名；相对路径按 `cwd` 解析（Finder 双击时 `cwd` 是 `/`）。
pub fn parse(
    argv: &[String],
    cwd: &Path,
    default_home: &Path,
) -> Result<ShellOptions, OptionsError> {
    let mut options = ShellOptions {
        smoke: false,
        home: default_home.to_path_buf(),
        workspace: cwd.to_path_buf(),
        cli_path: None,
        port: None,
        hold: None,
    };
    let mut index = 0;
    while index < argv.len() {
        let token = argv[index].as_str();
        index += 1;
        let value = |index: &mut usize| -> Result<&String, OptionsError> {
            let found = argv
                .get(*index)
                .ok_or(OptionsError::MissingValue(token.to_string()))?;
            *index += 1;
            Ok(found)
        };
        match token {
            "--smoke" => options.smoke = true,
            "--home" => options.home = resolve(value(&mut index)?, cwd),
            "--workspace" => options.workspace = resolve(value(&mut index)?, cwd),
            "--cli-path" => options.cli_path = Some(resolve(value(&mut index)?, cwd)),
            "--port" => {
                let raw = value(&mut index)?.to_string();
                let port = raw
                    .parse::<u16>()
                    .map_err(|_| OptionsError::BadPort(raw.clone()))?;
                if port == 0 {
                    return Err(OptionsError::BadPort(raw));
                }
                options.port = Some(port);
            }
            "--hold" => {
                let raw = value(&mut index)?.to_string();
                let seconds = raw
                    .parse::<u64>()
                    .map_err(|_| OptionsError::BadHold(raw.clone()))?;
                options.hold = Some(seconds);
            }
            "--open" => {
                // 值属于 `open_arg`，这里只跳过，避免被当成未知 flag。
                value(&mut index)?;
            }
            other if other.starts_with('-') => {
                return Err(OptionsError::UnknownFlag(other.to_string()))
            }
            // 位置参数只可能是 LaunchServices 给的双击路径，交给 `open_arg`。
            _ => {}
        }
    }
    Ok(options)
}

fn resolve(raw: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    fn parse_in(items: &[&str]) -> Result<ShellOptions, OptionsError> {
        parse(&argv(items), Path::new("/cwd"), Path::new("/home/user"))
    }

    fn defaults() -> ShellOptions {
        ShellOptions {
            smoke: false,
            home: PathBuf::from("/home/user"),
            workspace: PathBuf::from("/cwd"),
            cli_path: None,
            port: None,
            hold: None,
        }
    }

    #[test]
    fn ac1_no_arguments_keeps_cli_defaults() {
        assert_eq!(parse_in(&[]), Ok(defaults()));
    }

    #[test]
    fn ac1_flags_override_each_field() {
        let parsed = parse_in(&[
            "--smoke",
            "--home",
            "/tmp/h",
            "--workspace",
            "/tmp/ws",
            "--cli-path",
            "/opt/hr",
            "--port",
            "8123",
            "--hold",
            "3",
        ])
        .expect("合法参数");
        assert_eq!(
            parsed,
            ShellOptions {
                smoke: true,
                home: PathBuf::from("/tmp/h"),
                workspace: PathBuf::from("/tmp/ws"),
                cli_path: Some(PathBuf::from("/opt/hr")),
                port: Some(8123),
                hold: Some(3),
            }
        );
    }

    #[test]
    fn ac1_relative_directories_resolve_against_cwd() {
        let parsed =
            parse_in(&["--home", ".hreader-home", "--workspace", "docs"]).expect("相对路径");
        assert_eq!(parsed.home, PathBuf::from("/cwd/.hreader-home"));
        assert_eq!(parsed.workspace, PathBuf::from("/cwd/docs"));
    }

    #[test]
    fn ac1_open_value_is_not_read_as_a_directory() {
        let parsed = parse_in(&["--open", "/ws/a.html", "--home", "/tmp/h"]).expect("合法参数");
        assert_eq!(parsed.home, PathBuf::from("/tmp/h"));
    }

    #[test]
    fn ac1_missing_value_unknown_flag_and_bad_port_are_errors() {
        assert_eq!(
            parse_in(&["--home"]),
            Err(OptionsError::MissingValue("--home".to_string()))
        );
        assert_eq!(
            parse_in(&["--nope"]),
            Err(OptionsError::UnknownFlag("--nope".to_string()))
        );
        assert_eq!(
            parse_in(&["--port", "0"]),
            Err(OptionsError::BadPort("0".to_string()))
        );
        assert_eq!(
            parse_in(&["--port", "70000"]),
            Err(OptionsError::BadPort("70000".to_string()))
        );
        assert_eq!(
            parse_in(&["--hold", "soon"]),
            Err(OptionsError::BadHold("soon".to_string()))
        );
    }
}
