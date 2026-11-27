//! Shell-level settings persisted as `<shell home>/settings.json`.
//!
//! Unlike `daemon.json` this file is optional state: a missing or corrupt
//! settings file must degrade to defaults, never block startup.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SETTINGS_FILE: &str = "settings.json";

/// Everything the shell persists across launches that is not daemon/session
/// bookkeeping. New fields must stay `#[serde(default)]`-compatible so an
/// older settings file still loads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ShellSettings {
    /// Template id preselected in the new-document modal; `None` = blank document.
    #[serde(rename = "defaultTemplate", skip_serializing_if = "Option::is_none")]
    pub default_template: Option<String>,
}

pub fn settings_file_in(home: &Path) -> PathBuf {
    home.join(SETTINGS_FILE)
}

/// Read settings; `Err`/missing/corrupt all collapse to defaults — a broken
/// preference file is a lost preference, not a startup failure.
pub fn read_settings(home: &Path) -> ShellSettings {
    match fs::read_to_string(settings_file_in(home)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => ShellSettings::default(),
    }
}

pub fn write_settings(home: &Path, settings: &ShellSettings) -> std::io::Result<()> {
    fs::create_dir_all(home)?;
    let mut text = serde_json::to_string_pretty(settings)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    text.push('\n');
    fs::write(settings_file_in(home), text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hr-settings-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp home");
        dir
    }

    #[test]
    fn default_template_roundtrips_through_the_settings_file() {
        let home = temp_home("roundtrip");
        let settings = ShellSettings {
            default_template: Some("weekly-report".to_string()),
        };
        write_settings(&home, &settings).expect("settings file must be writable");
        assert_eq!(read_settings(&home), settings);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn clearing_the_default_persists_as_an_absent_key() {
        let home = temp_home("clear");
        write_settings(
            &home,
            &ShellSettings {
                default_template: Some("a".to_string()),
            },
        )
        .expect("seed a default");
        write_settings(&home, &ShellSettings::default()).expect("clear must write");
        assert_eq!(read_settings(&home).default_template, None);
        // `skip_serializing_if` keeps the cleared key out of the file entirely.
        let text = fs::read_to_string(settings_file_in(&home)).expect("file exists");
        assert!(!text.contains("defaultTemplate"), "{text}");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_or_corrupt_files_read_as_defaults() {
        let home = temp_home("defaults");
        assert_eq!(read_settings(&home), ShellSettings::default());
        fs::write(settings_file_in(&home), "{not json").expect("write junk");
        assert_eq!(
            read_settings(&home),
            ShellSettings::default(),
            "a corrupt settings file is a lost preference, not an error"
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn unknown_fields_from_a_newer_file_are_ignored() {
        let home = temp_home("forward");
        fs::write(
            settings_file_in(&home),
            r#"{"defaultTemplate":"x","futureKey":{"a":1}}"#,
        )
        .expect("write newer file");
        assert_eq!(read_settings(&home).default_template, Some("x".to_string()));
        let _ = fs::remove_dir_all(&home);
    }
}
