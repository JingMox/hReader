//! `--open <file>` / LaunchServices 传入的文档路径 → 动作（纯函数，不碰文件系统）。

use std::path::{Component, Path, PathBuf};

use crate::options::VALUE_FLAGS;

const HTML_EXTENSIONS: [&str; 2] = ["html", "htm"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// `doc_id` 是 workspace 相对路径，直接交给 `hr serve <file>`。
    OpenDocument { doc_id: String },
    /// 没有文档参数：不报错，就起空窗口。
    NoAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenArgError {
    MissingValue,
    OutsideWorkspace { path: String },
    NotHtmlDocument { path: String },
}

/// 先看 `--open <path>`，再看第一个真正的位置参数（Finder 双击时 argv 就是那个路径）。
fn document_argument(argv: &[String]) -> Result<Option<&str>, OpenArgError> {
    if let Some(index) = argv.iter().position(|token| token == "--open") {
        return argv
            .get(index + 1)
            .map(|value| Some(value.as_str()))
            .ok_or(OpenArgError::MissingValue);
    }
    let mut index = 0;
    while index < argv.len() {
        let token = argv[index].as_str();
        if VALUE_FLAGS.contains(&token) {
            index += 2;
            continue;
        }
        if !token.starts_with('-') {
            return Ok(Some(token));
        }
        index += 1;
    }
    Ok(None)
}

pub fn action_of(argv: &[String], workspace: &Path) -> Result<Action, OpenArgError> {
    match document_argument(argv)? {
        None => Ok(Action::NoAction),
        Some(raw) => doc_id_of(raw, workspace).map(|doc_id| Action::OpenDocument { doc_id }),
    }
}

fn doc_id_of(raw: &str, workspace: &Path) -> Result<String, OpenArgError> {
    let outside = || OpenArgError::OutsideWorkspace {
        path: raw.to_string(),
    };
    let not_html = || OpenArgError::NotHtmlDocument {
        path: raw.to_string(),
    };
    let absolute = absolutize(raw, workspace);
    let relative = absolute.strip_prefix(workspace).map_err(|_| outside())?;
    let doc_id = relative.to_string_lossy().replace('\\', "/");
    if doc_id.is_empty() {
        return Err(not_html());
    }
    match Path::new(&doc_id).extension() {
        Some(extension)
            if HTML_EXTENSIONS
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known)) => {}
        _ => return Err(not_html()),
    }
    Ok(doc_id)
}

fn absolutize(raw: &str, workspace: &Path) -> PathBuf {
    let candidate = Path::new(raw);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace.join(candidate)
    };
    let mut parts: Vec<Component> = Vec::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(parts.last(), Some(Component::Normal(_))) {
                    parts.pop();
                } else {
                    parts.push(component);
                }
            }
            other => parts.push(other),
        }
    }
    parts.iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    const WORKSPACE: &str = "/ws";

    fn ws() -> &'static Path {
        Path::new(WORKSPACE)
    }

    fn doc_id_of_arg(raw: &str) -> Result<Action, OpenArgError> {
        action_of(&argv(&["--open", raw]), ws())
    }

    #[test]
    fn ac6_absolute_path_inside_workspace_maps_to_relative_doc_id() {
        assert_eq!(
            doc_id_of_arg("/ws/a.html"),
            Ok(Action::OpenDocument {
                doc_id: "a.html".to_string()
            })
        );
    }

    #[test]
    fn ac6_nested_relative_path_keeps_its_directories() {
        assert_eq!(
            doc_id_of_arg("a/b.html"),
            Ok(Action::OpenDocument {
                doc_id: "a/b.html".to_string()
            })
        );
    }

    #[test]
    fn ac6_escaping_the_workspace_is_an_error() {
        assert_eq!(
            doc_id_of_arg("../x.html"),
            Err(OpenArgError::OutsideWorkspace {
                path: "../x.html".to_string()
            })
        );
        assert_eq!(
            doc_id_of_arg("/etc/x.html"),
            Err(OpenArgError::OutsideWorkspace {
                path: "/etc/x.html".to_string()
            })
        );
    }

    #[test]
    fn ac6_non_html_and_directory_inputs_are_named_errors() {
        assert_eq!(
            doc_id_of_arg("/ws/a.txt"),
            Err(OpenArgError::NotHtmlDocument {
                path: "/ws/a.txt".to_string()
            })
        );
        assert_eq!(
            doc_id_of_arg("/ws"),
            Err(OpenArgError::NotHtmlDocument {
                path: "/ws".to_string()
            })
        );
    }

    #[test]
    fn ac6_percent_escaped_input_is_literal_not_decoded() {
        assert_eq!(
            doc_id_of_arg("/ws/a%2Fb.html"),
            Ok(Action::OpenDocument {
                doc_id: "a%2Fb.html".to_string()
            })
        );
    }

    #[test]
    fn ac6_missing_value_and_no_argument() {
        assert_eq!(
            action_of(&argv(&["--open"]), ws()),
            Err(OpenArgError::MissingValue)
        );
        assert_eq!(action_of(&argv(&[]), ws()), Ok(Action::NoAction));
        assert_eq!(action_of(&argv(&["--smoke"]), ws()), Ok(Action::NoAction));
    }

    #[test]
    fn ac6_launch_services_positional_path_is_accepted() {
        assert_eq!(
            action_of(&argv(&["/ws/dir/doc.html"]), ws()),
            Ok(Action::OpenDocument {
                doc_id: "dir/doc.html".to_string()
            })
        );
    }

    #[test]
    fn ac6_values_of_other_flags_are_not_mistaken_for_a_document() {
        assert_eq!(
            action_of(
                &argv(&["--home", "/tmp/h", "--workspace", "/ws", "--port", "8123"]),
                ws()
            ),
            Ok(Action::NoAction)
        );
    }

    #[test]
    fn ac6_uppercase_extension_is_accepted() {
        assert_eq!(
            doc_id_of_arg("A.HTML"),
            Ok(Action::OpenDocument {
                doc_id: "A.HTML".to_string()
            })
        );
    }
}
