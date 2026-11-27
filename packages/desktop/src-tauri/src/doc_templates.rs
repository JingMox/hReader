//! `hr template …` glue for the desktop shell.
//!
//! The shell never re-implements template logic — it shells out to the bundled
//! CLI (`hr template list|new|save --json`) and only owns: parsing the CLI JSON,
//! the exact argv shape, the template tier roots, and the delete-path guard.
//! Pure module: no `tauri` imports (enforced by `scripts/check.sh`).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// One `hr template list` entry. `source` stays a raw string — unknown future
/// tiers still reach the UI; only `user`/`workspace` are deletable dirs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub format: String,
    pub tags: Vec<String>,
    pub source: String,
}

/// A template the CLI skipped (broken or shadowed). Fields can be empty — the
/// CLI records the dir name when the manifest id is unrecoverable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateDiagnostic {
    pub id: String,
    pub source: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TemplateList {
    pub templates: Vec<TemplateSummary>,
    pub diagnostics: Vec<TemplateDiagnostic>,
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Entries must carry a usable `id` and `source`; every other field degrades
/// to an empty value so one authored-manifest quirk never sinks the list.
fn parse_summary(value: &Value) -> Option<TemplateSummary> {
    let id = value.get("id")?.as_str()?.to_string();
    let source = value.get("source")?.as_str()?.to_string();
    if id.is_empty() || source.is_empty() {
        return None;
    }
    Some(TemplateSummary {
        name: string_field(value, "name").unwrap_or_else(|| id.clone()),
        id,
        description: string_field(value, "description").unwrap_or_default(),
        format: string_field(value, "format").unwrap_or_default(),
        tags: value
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(|tag| tag.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        source,
    })
}

fn parse_diagnostic(value: &Value) -> Option<TemplateDiagnostic> {
    if !value.is_object() {
        return None;
    }
    Some(TemplateDiagnostic {
        id: string_field(value, "id").unwrap_or_default(),
        source: string_field(value, "source").unwrap_or_default(),
        message: string_field(value, "message").unwrap_or_default(),
    })
}

/// Parse `hr template list --json` stdout: `{"ok":true,"data":{"templates":[…],"diagnostics":[…]}}`.
/// The envelope is strict (`ok:true` required); the entries inside are lenient —
/// malformed entries are skipped, never sink the whole list.
pub fn parse_template_list(raw: &str) -> Result<TemplateList, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|_| "hr template list 的输出不是 JSON".to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "hr template list 的输出顶层不是对象".to_string())?;
    if object.get("ok").and_then(Value::as_bool) != Some(true) {
        let message =
            string_field(&value, "message").unwrap_or_else(|| "hr template list 失败".to_string());
        return Err(message);
    }
    let data = object.get("data").cloned().unwrap_or(Value::Null);
    let rows_of = |key: &str| -> Vec<Value> {
        data.get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    Ok(TemplateList {
        templates: rows_of("templates")
            .iter()
            .filter_map(parse_summary)
            .collect(),
        diagnostics: rows_of("diagnostics")
            .iter()
            .filter_map(parse_diagnostic)
            .collect(),
    })
}

/// Extract the human message from a CLI `--json` error envelope; raw stderr /
/// stdout text passes through unchanged.
pub fn cli_error_message(raw: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        if let Some(message) = value.get("message").and_then(Value::as_str) {
            if !message.is_empty() {
                return message.to_string();
            }
        }
    }
    raw.trim().to_string()
}

/// The template id gate — mirrors core's `TEMPLATE_ID` (`/^[a-z0-9][a-z0-9-]{0,63}$/`).
/// Anything else (`..`, absolute paths, slashes, unicode) is refused before a
/// path is ever joined.
pub fn is_valid_template_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let head_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    head_ok
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// `hr template list --json`
pub fn template_list_args() -> [&'static str; 3] {
    ["template", "list", "--json"]
}

/// `hr template new <file> --template <id> --title <title> --json`
/// Every value is its own argv entry — no shell is ever involved.
pub fn template_new_args(file: &str, template_id: &str, title: &str) -> Vec<String> {
    vec![
        "template".to_string(),
        "new".to_string(),
        file.to_string(),
        "--template".to_string(),
        template_id.to_string(),
        "--title".to_string(),
        title.to_string(),
        "--json".to_string(),
    ]
}

/// `hr template save <file> --id <id> [--name <n>] [--description <d>] [--global] --json`
/// Optional flags are only emitted when they carry a value.
pub fn template_save_args(
    file: &str,
    id: &str,
    global: bool,
    name: &str,
    description: &str,
) -> Vec<String> {
    let mut args = vec![
        "template".to_string(),
        "save".to_string(),
        file.to_string(),
        "--id".to_string(),
        id.to_string(),
    ];
    if !name.is_empty() {
        args.push("--name".to_string());
        args.push(name.to_string());
    }
    if !description.is_empty() {
        args.push("--description".to_string());
        args.push(description.to_string());
    }
    if global {
        args.push("--global".to_string());
    }
    args.push("--json".to_string());
    args
}

/// The blank new-document style pass — **frozen argv**. The blank path is
/// byte-identical to before the template feature: changing this array changes
/// every new document's look.
pub fn blank_style_args(doc_name: &str) -> [&str; 4] {
    ["style", doc_name, "--visual", "atelier-editorial"]
}

/// User tier root `<config home>/.hreader/templates`. The CLI resolves
/// `HREADER_HOME` as the config root (parent of `.hreader/`); unset = real home.
/// `run_cli_task` inherits the environment, so this stays consistent with
/// whatever `hr template` computes.
pub fn user_templates_dir() -> Option<PathBuf> {
    let config_home = std::env::var_os("HREADER_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from)
        })?;
    Some(user_templates_dir_in(&config_home))
}

pub fn user_templates_dir_in(config_home: &Path) -> PathBuf {
    config_home.join(".hreader").join("templates")
}

/// Workspace tier root `<workspace>/.hreader/templates`.
pub fn workspace_templates_dir(workspace: &Path) -> PathBuf {
    workspace.join(".hreader").join("templates")
}

/// Why a delete request was refused — each variant maps to a user-facing reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteRefusal {
    /// `..`, absolute paths, slashes: the id string itself is hostile.
    InvalidId,
    /// Not in `hr template list` output — a bare bridge param is never trusted.
    NotListed,
    /// builtin or unknown-tier templates have no deletable dir on disk.
    NotDeletable,
    /// Missing dir, non-directory, or canonicalizes somewhere else (symlink escape).
    UnsafePath,
    /// Filesystem trouble while checking the path.
    Unreadable,
}

impl DeleteRefusal {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidId => "模板 ID 不合法",
            Self::NotListed => "该模板不在当前列表中",
            Self::NotDeletable => "内置或未知来源的模板不能删除",
            Self::UnsafePath => "模板路径不安全或不存在",
            Self::Unreadable => "无法读取模板目录",
        }
    }
}

/// The only path a delete may touch: literally `<tier root>/<id>` for a template
/// the CLI just listed as `user`/`workspace` — canonicalized, real directory,
/// never a symlink (a symlinked template dir could point anywhere).
pub fn deletable_template_dir(
    id: &str,
    listed: &[TemplateSummary],
    user_root: &Path,
    workspace_root: &Path,
) -> Result<PathBuf, DeleteRefusal> {
    if !is_valid_template_id(id) {
        return Err(DeleteRefusal::InvalidId);
    }
    let entry = listed
        .iter()
        .find(|entry| entry.id == id)
        .ok_or(DeleteRefusal::NotListed)?;
    let root = match entry.source.as_str() {
        "user" => user_root,
        "workspace" => workspace_root,
        _ => return Err(DeleteRefusal::NotDeletable),
    };
    let candidate = root.join(id);
    let meta = fs::symlink_metadata(&candidate).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => DeleteRefusal::UnsafePath,
        _ => DeleteRefusal::Unreadable,
    })?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(DeleteRefusal::UnsafePath);
    }
    let root_real = root.canonicalize().map_err(|_| DeleteRefusal::Unreadable)?;
    let real = candidate
        .canonicalize()
        .map_err(|_| DeleteRefusal::Unreadable)?;
    if real != root_real.join(id) {
        return Err(DeleteRefusal::UnsafePath);
    }
    Ok(real)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str, source: &str) -> TemplateSummary {
        TemplateSummary {
            id: id.to_string(),
            name: format!("模板 {id}"),
            description: String::new(),
            format: "single".to_string(),
            tags: vec![],
            source: source.to_string(),
        }
    }

    #[test]
    fn parses_a_valid_envelope_with_templates_and_diagnostics() {
        let raw = r#"{"ok":true,"data":{"templates":[
            {"id":"blank-html","name":"Blank HTML","description":"d","format":"single","tags":["base"],"source":"builtin"},
            {"id":"周报","name":"周报","description":"","format":"single","tags":[],"source":"user"}
        ],"diagnostics":[{"id":"broken","source":"workspace","message":"template.json 不是 JSON"}]}}"#;
        let list = parse_template_list(raw).expect("valid envelope must parse");
        assert_eq!(list.templates.len(), 2);
        assert_eq!(list.templates[0].id, "blank-html");
        assert_eq!(list.templates[0].source, "builtin");
        assert_eq!(list.templates[0].tags, vec!["base"]);
        assert_eq!(list.templates[1].name, "周报");
        assert_eq!(list.diagnostics.len(), 1);
        assert_eq!(list.diagnostics[0].source, "workspace");
    }

    #[test]
    fn malformed_json_and_ok_false_are_errors() {
        assert!(parse_template_list("not json").is_err());
        assert!(parse_template_list("[1,2]").is_err());
        let err = parse_template_list(r#"{"ok":false,"code":"io","message":"读取失败"}"#)
            .expect_err("ok:false must fail");
        assert_eq!(err, "读取失败");
        assert!(parse_template_list(r#"{"ok":false}"#).is_err());
    }

    #[test]
    fn missing_fields_degrade_instead_of_sinking_the_list() {
        let raw = r#"{"ok":true,"data":{"templates":[
            {"id":"a","source":"user"},
            {"id":"","source":"user"},
            {"name":"no id","source":"user"},
            {"id":"b"},
            "not-an-object",
            {"id":"c","source":"workspace","tags":["x",1,"y"],"name":42}
        ]}}"#;
        let list = parse_template_list(raw).expect("lenient entries must parse");
        let ids: Vec<&str> = list.templates.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["a", "c"]);
        assert_eq!(list.templates[0].name, "a", "missing name falls back to id");
        assert_eq!(list.templates[1].tags, vec!["x", "y"]);
    }

    #[test]
    fn a_huge_list_parses_without_choking() {
        let entries: Vec<String> = (0..5000)
            .map(|i| format!(r#"{{"id":"t{i}","name":"n{i}","source":"user"}}"#))
            .collect();
        let raw = format!(
            r#"{{"ok":true,"data":{{"templates":[{}],"diagnostics":[]}}}}"#,
            entries.join(",")
        );
        let list = parse_template_list(&raw).expect("huge list must parse");
        assert_eq!(list.templates.len(), 5000);
    }

    #[test]
    fn template_id_validation_matches_the_cli_rule() {
        assert!(is_valid_template_id("a"));
        assert!(is_valid_template_id("weekly-report-2024"));
        assert!(!is_valid_template_id(""));
        assert!(!is_valid_template_id(".."));
        assert!(!is_valid_template_id("../etc"));
        assert!(!is_valid_template_id("/abs"));
        assert!(!is_valid_template_id("a/b"));
        assert!(!is_valid_template_id("A"));
        assert!(!is_valid_template_id("-a"));
        assert!(!is_valid_template_id("周报"));
        assert!(!is_valid_template_id(&"a".repeat(65)));
        assert!(is_valid_template_id(&"a".repeat(64)));
    }

    #[test]
    fn argv_is_exact_and_never_concatenated() {
        assert_eq!(template_list_args(), ["template", "list", "--json"]);
        assert_eq!(
            template_new_args("笔记 note.html", "my-tpl", "标题 \"引号\" 中文"),
            [
                "template",
                "new",
                "笔记 note.html",
                "--template",
                "my-tpl",
                "--title",
                "标题 \"引号\" 中文",
                "--json"
            ]
        );
        // Optional flags appear only when they carry a value.
        assert_eq!(
            template_save_args("doc.html", "my-id", false, "", ""),
            ["template", "save", "doc.html", "--id", "my-id", "--json"]
        );
        assert_eq!(
            template_save_args("a b.html", "my-id", true, "名 称", "描述 \"d\""),
            [
                "template",
                "save",
                "a b.html",
                "--id",
                "my-id",
                "--name",
                "名 称",
                "--description",
                "描述 \"d\"",
                "--global",
                "--json"
            ]
        );
    }

    #[test]
    fn blank_doc_style_argv_is_frozen() {
        assert_eq!(
            blank_style_args("x.html"),
            ["style", "x.html", "--visual", "atelier-editorial"]
        );
    }

    #[test]
    fn cli_error_message_prefers_the_json_envelope() {
        assert_eq!(
            cli_error_message(r#"{"ok":false,"code":"file_exists","message":"目标已存在"}"#),
            "目标已存在"
        );
        assert_eq!(cli_error_message("plain stderr text"), "plain stderr text");
        assert_eq!(cli_error_message("  "), "");
    }

    #[test]
    fn delete_guard_refuses_hostile_ids_before_touching_the_fs() {
        let root = std::env::temp_dir().join(format!("hr-guard-{}", std::process::id()));
        let listed = vec![summary("ok", "user")];
        for hostile in ["..", "../x", "/abs", "a/b", "UPPER"] {
            assert_eq!(
                deletable_template_dir(hostile, &listed, &root, &root),
                Err(DeleteRefusal::InvalidId),
                "{hostile} must be refused"
            );
        }
        assert_eq!(
            deletable_template_dir("ghost", &listed, &root, &root),
            Err(DeleteRefusal::NotListed)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_guard_refuses_builtin_and_unknown_sources() {
        let dir = std::env::temp_dir().join(format!("hr-guard-src-{}", std::process::id()));
        let user_root = dir.join("user");
        let ws_root = dir.join("ws");
        fs::create_dir_all(user_root.join("t")).expect("mkdir");
        fs::create_dir_all(ws_root.join("t")).expect("mkdir");
        for source in ["builtin", "future-tier"] {
            let listed = vec![summary("t", source)];
            assert_eq!(
                deletable_template_dir("t", &listed, &user_root, &ws_root),
                Err(DeleteRefusal::NotDeletable),
                "source {source} must not be deletable"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_guard_accepts_a_real_listed_dir_and_refuses_escapes() {
        let dir = std::env::temp_dir().join(format!("hr-guard-ok-{}", std::process::id()));
        let user_root = dir.join("user").join(".hreader").join("templates");
        let ws_root = dir.join("ws").join(".hreader").join("templates");
        fs::create_dir_all(user_root.join("mine")).expect("mkdir user tpl");
        fs::create_dir_all(ws_root.join("mine")).expect("mkdir ws tpl");
        let listed = vec![summary("mine", "user"), summary("mine-ws", "workspace")];
        fs::create_dir_all(ws_root.join("mine-ws")).expect("mkdir ws tpl 2");
        assert_eq!(
            deletable_template_dir("mine", &listed, &user_root, &ws_root)
                .expect("real user dir must pass"),
            user_root.join("mine").canonicalize().expect("canonical")
        );
        // A regular file at <root>/<id> is not a template dir.
        fs::write(user_root.join("afile"), "x").expect("write file");
        let listed_file = vec![summary("afile", "user")];
        assert_eq!(
            deletable_template_dir("afile", &listed_file, &user_root, &ws_root),
            Err(DeleteRefusal::UnsafePath)
        );
        // Missing dir is refused, never created by the guard.
        let listed_missing = vec![summary("gone", "user")];
        assert_eq!(
            deletable_template_dir("gone", &listed_missing, &user_root, &ws_root),
            Err(DeleteRefusal::UnsafePath)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn delete_guard_refuses_a_symlinked_template_dir_pointing_out() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("hr-guard-sym-{}", std::process::id()));
        let user_root = dir.join("templates");
        let outside = dir.join("outside");
        fs::create_dir_all(&user_root).expect("mkdir root");
        fs::create_dir_all(&outside).expect("mkdir outside");
        symlink(&outside, user_root.join("sneaky")).expect("symlink");
        let listed = vec![summary("sneaky", "user")];
        assert_eq!(
            deletable_template_dir("sneaky", &listed, &user_root, &dir),
            Err(DeleteRefusal::UnsafePath),
            "a symlinked template dir is refused even though its target exists"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tier_roots_match_the_cli_layout() {
        assert_eq!(
            user_templates_dir_in(Path::new("/home/u")),
            Path::new("/home/u/.hreader/templates")
        );
        assert_eq!(
            workspace_templates_dir(Path::new("/ws")),
            Path::new("/ws/.hreader/templates")
        );
    }
}
