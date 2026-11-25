//! 自定义 JSON 主题的加载、字段校验与安全清洗。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize, Serializer};

const SAMPLE_CUSTOM_THEME: &str = include_str!("../../../templates/sample-theme.json");

/// 用户自定义外观主题（从 `~/.hreader/themes/*.json` 或 `<workspace>/.hreader/themes/*.json` 加载）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub base: String,
    #[serde(serialize_with = "serialize_vars_map")]
    pub vars: Vec<(String, String)>,
    pub css: String,
}

fn serialize_vars_map<S: Serializer>(
    vars: &[(String, String)],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(vars.iter().map(|(k, v)| (k, v)))
}

/// 宽松字段解码：类型不符时忽略原值而不是整份主题拒载。
#[derive(Deserialize)]
#[serde(untagged)]
enum Lenient<T> {
    Valid(T),
    #[allow(dead_code)]
    Invalid(IgnoredAny),
}

impl<T> Lenient<T> {
    fn into_option(self) -> Option<T> {
        match self {
            Self::Valid(value) => Some(value),
            Self::Invalid(_) => None,
        }
    }
}

#[derive(Deserialize)]
struct RawCustomTheme {
    id: Option<Lenient<String>>,
    name: Option<Lenient<String>>,
    base: Option<Lenient<String>>,
    vars: Option<Lenient<BTreeMap<String, Lenient<String>>>>,
    css: Option<Lenient<String>>,
}

/// 返回用户级自定义主题配置目录（`~/.hreader/themes`）。
pub fn user_themes_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    Some(home.join(".hreader").join("themes"))
}

/// 确保主题目录存在；若尚无任何 `.json` 主题文件，写入一份可直接修改的示例配置文件。
pub fn ensure_user_themes_dir_in(dir: &Path) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let has_json = fs::read_dir(dir).ok().is_some_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        })
    });
    if !has_json {
        fs::write(dir.join("nord-example.json"), SAMPLE_CUSTOM_THEME)?;
    }
    Ok(dir.to_path_buf())
}

/// 从用户全局目录与工作区 `.hreader/themes/*.json` 加载已校验的安全自定义主题。
pub fn load_custom_themes(user_dir: Option<&Path>, workspace: &Path) -> Vec<CustomTheme> {
    let mut themes: Vec<CustomTheme> = Vec::new();
    if let Some(dir) = user_dir {
        read_themes_from_dir(dir, &mut themes);
    }
    let ws_themes = workspace.join(".hreader").join("themes");
    read_themes_from_dir(&ws_themes, &mut themes);
    themes
}

fn read_themes_from_dir(dir: &Path, out: &mut Vec<CustomTheme>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        })
        .collect();
    paths.sort();
    for path in paths {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("custom");
        let Some(theme) = parse_custom_theme_json(&raw, stem) else {
            continue;
        };
        if let Some(slot) = out.iter_mut().find(|existing| existing.id == theme.id) {
            *slot = theme;
        } else {
            out.push(theme);
        }
    }
}

fn parse_custom_theme_json(raw: &str, fallback_stem: &str) -> Option<CustomTheme> {
    let parsed: RawCustomTheme = serde_json::from_str(raw).ok()?;
    let raw_id = parsed.id.and_then(Lenient::into_option);
    let id = sanitize_theme_id(raw_id.as_deref().unwrap_or(fallback_stem), fallback_stem);
    let raw_name = parsed.name.and_then(Lenient::into_option);
    let name = raw_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&id)
        .chars()
        .take(64)
        .collect::<String>();
    let raw_base = parsed.base.and_then(Lenient::into_option);
    let base = sanitize_theme_base(raw_base.as_deref());

    let mut vars = Vec::new();
    if let Some(map) = parsed.vars.and_then(Lenient::into_option) {
        for (k, v) in map {
            if let Some(val_str) = v.into_option() {
                let val_trimmed = val_str.trim();
                if is_safe_css_var_name(&k) && is_safe_css_var_value(val_trimmed) {
                    vars.push((k, val_trimmed.to_string()));
                }
            }
        }
    }

    let css = parsed
        .css
        .and_then(Lenient::into_option)
        .map(|text| sanitize_custom_css(&text))
        .unwrap_or_default();

    Some(CustomTheme {
        id,
        name,
        base,
        vars,
        css,
    })
}

fn sanitize_theme_id(raw: &str, fallback: &str) -> String {
    let filter = |input: &str| -> String {
        input
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(48)
            .collect()
    };
    let mut id = filter(raw);
    if id.is_empty() {
        id = filter(fallback);
    }
    if id.is_empty() {
        id = "custom-theme".to_string();
    }
    if matches!(id.as_str(), "light" | "paper" | "dark") {
        format!("custom-{id}")
    } else {
        id
    }
}

fn sanitize_theme_base(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some("paper") => "paper".to_string(),
        Some("dark") => "dark".to_string(),
        _ => "light".to_string(),
    }
}

fn is_safe_css_var_name(name: &str) -> bool {
    name.starts_with("--")
        && name.len() >= 3
        && name.len() <= 64
        && name[2..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn is_safe_css_var_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains([';', '{', '}', '<', '\n', '\r'])
}

fn sanitize_custom_css(raw: &str) -> String {
    let mut out = raw.to_string();
    loop {
        let lower = out.to_ascii_lowercase();
        let Some(pos) = lower.find("</style") else {
            break;
        };
        out.replace_range(pos..pos + 7, "");
    }
    out.chars().take(16_384).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ws(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hr-wb-themes-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn load_custom_themes_parses_valid_json_and_sanitizes_vars() {
        let root = temp_ws("themes");
        let user_dir = root.join("user-themes");
        let ws = root.join("vault");
        fs::create_dir_all(&ws).expect("vault dir");
        ensure_user_themes_dir_in(&user_dir).expect("ensure user themes");
        assert!(user_dir.join("nord-example.json").is_file());

        let ws_themes = ws.join(".hreader/themes");
        fs::create_dir_all(&ws_themes).expect("ws themes");
        fs::write(
            ws_themes.join("custom.json"),
            r##"{
              "id": "forest/bad",
              "name": "Forest",
              "base": "paper",
              "vars": {
                "--hr-accent": "#2d6a4f",
                "bad-key": "#fff",
                "--inject": "red; } </style>"
              },
              "css": "body { opacity: 1; }</style><script>alert(1)</script>"
            }"##,
        )
        .expect("write custom json");
        fs::write(ws_themes.join("broken.json"), "{ not valid json").expect("write broken");

        let themes = load_custom_themes(Some(&user_dir), &ws);
        assert_eq!(themes.len(), 2);
        assert_eq!(themes[0].id, "nord-slate");
        assert_eq!(themes[0].base, "dark");
        let forest = &themes[1];
        assert_eq!(forest.id, "forestbad");
        assert_eq!(forest.base, "paper");
        assert_eq!(
            forest.vars,
            vec![("--hr-accent".to_string(), "#2d6a4f".to_string())]
        );
        assert!(!forest.css.to_ascii_lowercase().contains("</style"));
        let _ = fs::remove_dir_all(&root);
    }

    /// `</style` 的所有 HTML 合法收尾变体都必须被剥掉：大小写、`/`、空白、`>`，
    /// 以及注释/CDATA/字符串等包壳——HTML 解析器只认 `</style` 这个前缀，逐处清除后
    /// 无论外面套什么壳都无法提前终止 style 元素。
    #[test]
    fn sanitize_strips_every_close_style_variant() {
        let variants = [
            "</style>",
            "</STYLE>",
            "</Style\n>",
            "</style\r\n>",
            "</style/>",
            "</style foo>",
            "/*</style>*/",
            "<![CDATA[</style>]]>",
            "\"</style>\"",
            "a</style>b</STYLE>c",
        ];
        for variant in variants {
            let out = sanitize_custom_css(&format!("x{{color:red}}{variant}y{{color:blue}}"));
            assert!(
                !out.to_ascii_lowercase().contains("</style"),
                "{variant:?} 绕过成功：{out}"
            );
        }
    }

    /// `< /style`（`<` 与 `/` 之间有空格）不是 HTML 的合法闭合标签，保留无害。
    #[test]
    fn spaced_close_tag_is_not_an_end_tag() {
        let out = sanitize_custom_css("a::before{content:\"< /style>\"}");
        assert!(out.contains("< /style"));
    }

    /// 主题 JSON 也是有界输入：超限文件直接跳过，不为不可能合法的输入付出无界内存。
    #[test]
    fn oversized_theme_file_is_skipped() {
        let root = temp_ws("themes-big");
        let themes_dir = root.join("vault").join(".hreader/themes");
        fs::create_dir_all(&themes_dir).expect("create themes dir");
        let huge = format!(
            "{{\"id\":\"big\",\"name\":\"Big\",\"css\":\"{}\"}}",
            "x".repeat(2 * 1024 * 1024)
        );
        fs::write(themes_dir.join("big.json"), huge).expect("write oversized theme");
        let themes = load_custom_themes(None, &root.join("vault"));
        assert!(themes.is_empty(), "超限主题文件必须跳过");
        let _ = fs::remove_dir_all(&root);
    }
}
