//! `daemon.json` 的三态读取：可用 / 无文件 / 存在但坏。
//!
//! 三态不能压成 `Option`：坏文件与"没有文件"要给出不同处置——把坏文件当成"没 daemon"就会
//! 静默再拉起一个，而残留文件仍挡着下一次启动，用户看到的是"看起来正常但永远复用不到"。

use std::fmt;
use std::fs;
use std::num::{NonZeroU16, NonZeroU32};
use std::path::{Path, PathBuf};

use serde::de::IgnoredAny;
use serde::Deserialize;

/// core 的落盘位置：`<home>/.hreader/daemon.json`（`packages/core/src/server/daemon.ts`）。
pub const STORE_DIR: &str = ".hreader";
pub const DAEMON_FILE: &str = "daemon.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub workspace: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonState {
    Absent,
    Present(DaemonInfo),
}

/// 坏的 `daemon.json`：只带路径与"哪一类原因"，绝不带字段值（`token` 不许进任何文案）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadDaemonFile {
    path: PathBuf,
    reason: &'static str,
}

impl BadDaemonFile {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl fmt::Display for BadDaemonFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} 不是可用的 daemon.json：{}",
            self.path.display(),
            self.reason
        )
    }
}

impl std::error::Error for BadDaemonFile {}

/// 字段级宽松反序列化：值不合类型时吞掉原值，避免 serde 错误文本把敏感字段值（如 `token`）带进报错。
#[derive(Deserialize)]
#[serde(untagged)]
enum Field<T> {
    Valid(T),
    #[allow(dead_code)]
    Invalid(IgnoredAny),
}

impl<T> Field<T> {
    fn valid(self) -> Option<T> {
        match self {
            Self::Valid(value) => Some(value),
            Self::Invalid(_) => None,
        }
    }
}

#[derive(Deserialize)]
struct RawDaemonFile {
    port: Option<Field<NonZeroU16>>,
    pid: Option<Field<NonZeroU32>>,
    token: Option<Field<String>>,
    workspace: Option<Field<String>>,
}

pub fn daemon_file_in(home: &Path) -> PathBuf {
    home.join(STORE_DIR).join(DAEMON_FILE)
}

pub fn read_daemon(path: &Path) -> Result<DaemonState, BadDaemonFile> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DaemonState::Absent)
        }
        Err(_) => {
            return Err(BadDaemonFile {
                path: path.to_path_buf(),
                reason: "无法读取",
            })
        }
    };
    parse_daemon(path, &text)
}

fn parse_daemon(path: &Path, text: &str) -> Result<DaemonState, BadDaemonFile> {
    let bad = |reason: &'static str| BadDaemonFile {
        path: path.to_path_buf(),
        reason,
    };
    let raw: RawDaemonFile = serde_json::from_str(text).map_err(|error| {
        if error.is_syntax() || error.is_eof() {
            bad("不是 JSON")
        } else {
            bad("顶层不是对象")
        }
    })?;
    let port = raw
        .port
        .and_then(Field::valid)
        .ok_or_else(|| bad("port 不可用"))?;
    let pid = raw
        .pid
        .and_then(Field::valid)
        .ok_or_else(|| bad("pid 不可用"))?;
    let token = raw
        .token
        .and_then(Field::valid)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| bad("token 不可用"))?;
    let workspace = raw
        .workspace
        .and_then(Field::valid)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| bad("workspace 不可用"))?;
    Ok(DaemonState::Present(DaemonInfo {
        port: port.get(),
        token,
        pid: pid.get(),
        workspace: PathBuf::from(workspace),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/daemon")
            .join(name)
    }

    #[test]
    fn ac1_ok_file_is_present_with_all_four_fields() {
        let state = read_daemon(&fixture("ok.json")).expect("ok.json 必须可读");
        assert_eq!(
            state,
            DaemonState::Present(DaemonInfo {
                port: 8123,
                token: "Qm9vR2xtU3R4dHl6MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE0N".to_string(),
                pid: 4242,
                workspace: PathBuf::from("/ws"),
            })
        );
    }

    #[test]
    fn ac1_missing_file_is_absent_not_error() {
        let state =
            read_daemon(Path::new("/definitely/not/here/daemon.json")).expect("缺失不算坏文件");
        assert_eq!(state, DaemonState::Absent);
    }

    #[test]
    fn ac1_bad_json_is_error_not_absent() {
        let error = read_daemon(&fixture("bad-json.json")).expect_err("坏 JSON 必须报错");
        assert_eq!(error.path(), fixture("bad-json.json"));
        assert!(error.to_string().contains("不是 JSON"));
    }

    #[test]
    fn ac1_missing_field_field_keys_and_values_not_leaked() {
        let error = read_daemon(&fixture("field-missing.json")).expect_err("缺字段必须报错");
        assert!(error.to_string().contains("port 不可用"));
        // 值是 "8123" 字符串：报错文案只允许出现字段名，不许出现任何字段值。
        let error = read_daemon(&fixture("port-string.json")).expect_err("字符串端口必须报错");
        assert!(!error.to_string().contains("8123"));
        assert!(!error.to_string().contains("token"));
    }

    #[test]
    fn ac1_port_zero_and_empty_token_are_errors() {
        assert!(read_daemon(&fixture("port-zero.json")).is_err());
        assert!(read_daemon(&fixture("token-empty.json")).is_err());
    }

    #[test]
    fn ac1_top_level_non_object_is_error() {
        let error = read_daemon(&fixture("not-an-object.json")).expect_err("非对象必须报错");
        assert!(error.to_string().contains("顶层不是对象"));
    }
}
