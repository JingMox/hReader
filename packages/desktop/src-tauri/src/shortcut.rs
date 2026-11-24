//! 全局快捷键配置的解析：可解析、可关闭（`null`）、默认值必含修饰键。

use std::collections::BTreeMap;

/// 唯一真源：`packages/desktop/accels.json`（JS 侧的冲突检查也读同一份文件）。
const ACCELS_JSON: &str = include_str!("../../accels.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modifier {
    CommandOrCtrl,
    Ctrl,
    Alt,
    Shift,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accel {
    pub modifiers: Vec<Modifier>,
    pub code: String,
}

impl Accel {
    /// 与书写顺序无关的同一性：`CmdOrCtrl+Shift+H` 与 `Shift+CmdOrCtrl+H` 是同一个键。
    fn signature(&self) -> String {
        let mut modifiers: Vec<&Modifier> = self.modifiers.iter().collect();
        modifiers.sort_by_key(|modifier| format!("{modifier:?}"));
        let names: Vec<String> = modifiers.iter().map(|item| format!("{item:?}")).collect();
        format!("{}|{}", names.join("+"), self.code.to_ascii_lowercase())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccelError {
    Empty,
    MissingKey,
    UnknownModifier(String),
    /// 只有 Shift 不算：阅读器的 `Shift+D` 是应用内键，全局键必须带真修饰键才不抢它。
    MissingModifier,
    /// `Escape` 是阅读器的关窗/退焦点键，占它等于把应用按键吃掉。
    ReservedKey,
    /// 两个别名注册了同一个键：后一个会被系统当作"已占用"而注册失败，必须在加载期就说清楚。
    DuplicateAccelerator {
        first: String,
        second: String,
    },
    InvalidConfig,
}

fn modifier_of(name: &str) -> Result<Modifier, AccelError> {
    match name {
        "CmdOrCtrl" | "CommandOrControl" => Ok(Modifier::CommandOrCtrl),
        "Ctrl" | "Control" => Ok(Modifier::Ctrl),
        "Alt" | "Option" => Ok(Modifier::Alt),
        "Shift" => Ok(Modifier::Shift),
        other => Err(AccelError::UnknownModifier(other.to_string())),
    }
}

pub fn parse_accel(text: &str) -> Result<Accel, AccelError> {
    if text.is_empty() {
        return Err(AccelError::Empty);
    }
    let parts: Vec<&str> = text.split('+').collect();
    let (code, modifier_names) = parts.split_last().ok_or(AccelError::Empty)?;
    if code.is_empty() {
        return Err(AccelError::MissingKey);
    }
    let mut modifiers = Vec::new();
    for name in modifier_names {
        modifiers.push(modifier_of(name)?);
    }
    let strong = modifiers.iter().any(|modifier| {
        matches!(
            modifier,
            Modifier::CommandOrCtrl | Modifier::Ctrl | Modifier::Alt
        )
    });
    if !strong {
        return Err(AccelError::MissingModifier);
    }
    if code.eq_ignore_ascii_case("escape") {
        return Err(AccelError::ReservedKey);
    }
    Ok(Accel {
        modifiers,
        code: (*code).to_string(),
    })
}

/// `null` 配置 = 关闭全部全局快捷键（返回空列表，不是错误、也不许因此起不来）。
pub fn accels_from_json(text: &str) -> Result<Vec<(String, Accel)>, AccelError> {
    let entries: Option<BTreeMap<String, String>> =
        serde_json::from_str(text).map_err(|_| AccelError::InvalidConfig)?;
    let Some(entries) = entries else {
        return Ok(Vec::new());
    };
    let mut accels = Vec::with_capacity(entries.len());
    for (name, raw) in entries {
        accels.push((name, parse_accel(&raw)?));
    }
    reject_duplicates(&accels)?;
    Ok(accels)
}

/// 同一个键被两个别名注册：系统只会认第一个，第二个静默失效（比报错更难查），所以这里直接拒绝。
fn reject_duplicates(accels: &[(String, Accel)]) -> Result<(), AccelError> {
    let mut seen: Vec<(String, String)> = Vec::new();
    for (name, accel) in accels {
        let signature = accel.signature();
        if let Some((first, _)) = seen.iter().find(|(_, known)| *known == signature) {
            return Err(AccelError::DuplicateAccelerator {
                first: first.clone(),
                second: name.clone(),
            });
        }
        seen.push((name.clone(), signature));
    }
    Ok(())
}

pub fn default_accels() -> Result<Vec<(String, Accel)>, AccelError> {
    accels_from_json(ACCELS_JSON)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ac7_parses_a_normal_accelerator() {
        assert_eq!(
            parse_accel("CmdOrCtrl+Shift+H"),
            Ok(Accel {
                modifiers: vec![Modifier::CommandOrCtrl, Modifier::Shift],
                code: "H".to_string(),
            })
        );
    }

    #[test]
    fn ac7_rejects_unmodified_keys() {
        assert_eq!(parse_accel("H"), Err(AccelError::MissingModifier));
        assert_eq!(parse_accel("Shift+H"), Err(AccelError::MissingModifier));
    }

    #[test]
    fn ac7_rejects_empty_and_dangling_plus() {
        assert_eq!(parse_accel(""), Err(AccelError::Empty));
        assert_eq!(parse_accel("CmdOrCtrl+"), Err(AccelError::MissingKey));
        assert_eq!(
            parse_accel("+H"),
            Err(AccelError::UnknownModifier("".to_string()))
        );
    }

    #[test]
    fn ac7_rejects_unknown_modifier_and_escape() {
        assert_eq!(
            parse_accel("Hyper+H"),
            Err(AccelError::UnknownModifier("Hyper".to_string()))
        );
        assert_eq!(
            parse_accel("CmdOrCtrl+Escape"),
            Err(AccelError::ReservedKey)
        );
    }

    #[test]
    fn ac7_null_config_means_no_shortcuts() {
        assert_eq!(accels_from_json("null"), Ok(Vec::new()));
    }

    #[test]
    fn ac7_bad_config_is_an_error_not_silence() {
        assert_eq!(accels_from_json("{"), Err(AccelError::InvalidConfig));
        assert_eq!(accels_from_json("[]"), Err(AccelError::InvalidConfig));
        assert_eq!(
            accels_from_json("{\"a\":1}"),
            Err(AccelError::InvalidConfig)
        );
        assert_eq!(
            accels_from_json("{\"a\":\"H\"}"),
            Err(AccelError::MissingModifier)
        );
    }

    #[test]
    fn ac7_duplicate_accelerator_is_rejected_with_both_aliases() {
        assert_eq!(
            accels_from_json(
                "{\"showWindow\":\"CmdOrCtrl+Shift+H\",\"showWindowAlt\":\"Shift+CmdOrCtrl+H\"}"
            ),
            Err(AccelError::DuplicateAccelerator {
                first: "showWindow".to_string(),
                second: "showWindowAlt".to_string(),
            })
        );
    }

    #[test]
    fn ac7_distinct_keys_are_not_duplicates() {
        let accels = accels_from_json(
            "{\"a\":\"CmdOrCtrl+Shift+H\",\"b\":\"CmdOrCtrl+Shift+K\",\"c\":\"Ctrl+Shift+H\"}",
        )
        .expect("不同键必须都留下");
        assert_eq!(accels.len(), 3);
    }

    #[test]
    fn ac7_default_accels_all_have_a_real_modifier() {
        let accels = default_accels().expect("accels.json 必须可解析");
        assert!(!accels.is_empty());
        for (name, accel) in &accels {
            assert!(!name.is_empty());
            assert!(!accel.code.eq_ignore_ascii_case("escape"));
        }
    }
}
