//! `hr` CLI 的三级定位：`--cli-path` > `HREADER_CLI` > `PATH`（纯决策，存在性判定由调用方注入）。

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Flag,
    Env,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub cli: PathBuf,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocateError {
    /// 显式给了但那个路径不在：不静默往下回退（否则用户以为在用自己那份 `hr`）。
    ExplicitMissing(PathBuf),
    /// 三级全落空：干净机器需要先 `npm i -g @hreader/cli` 或设 `HREADER_CLI`。
    NotFound,
}

pub fn locate(
    explicit: Option<&Path>,
    env_cli: Option<&Path>,
    path_var: Option<&str>,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<Located, LocateError> {
    if let Some(candidate) = explicit {
        return if exists(candidate) {
            Ok(Located {
                cli: candidate.to_path_buf(),
                source: Source::Flag,
            })
        } else {
            Err(LocateError::ExplicitMissing(candidate.to_path_buf()))
        };
    }
    if let Some(candidate) = env_cli {
        if exists(candidate) {
            return Ok(Located {
                cli: candidate.to_path_buf(),
                source: Source::Env,
            });
        }
    }
    for directory in path_var
        .unwrap_or("")
        .split(':')
        .filter(|item| !item.is_empty())
    {
        let candidate = Path::new(directory).join("hr");
        if exists(&candidate) {
            return Ok(Located {
                cli: candidate,
                source: Source::Path,
            });
        }
    }
    Err(LocateError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn only_these(paths: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |candidate: &Path| paths.iter().any(|known| Path::new(known) == candidate)
    }

    #[test]
    fn ac6_flag_wins_over_env_and_path() {
        let exists = only_these(&["/flag/hr", "/env/hr", "/bin/hr"]);
        assert_eq!(
            locate(
                Some(Path::new("/flag/hr")),
                Some(Path::new("/env/hr")),
                Some("/usr/bin:/bin"),
                &exists
            ),
            Ok(Located {
                cli: PathBuf::from("/flag/hr"),
                source: Source::Flag,
            })
        );
    }

    #[test]
    fn ac6_env_wins_over_path() {
        let exists = only_these(&["/env/hr", "/bin/hr"]);
        assert_eq!(
            locate(
                None,
                Some(Path::new("/env/hr")),
                Some("/usr/bin:/bin"),
                &exists
            ),
            Ok(Located {
                cli: PathBuf::from("/env/hr"),
                source: Source::Env,
            })
        );
    }

    #[test]
    fn ac6_path_is_the_last_resort() {
        let exists = only_these(&["/bin/hr"]);
        assert_eq!(
            locate(None, None, Some("/usr/bin:/bin"), &exists),
            Ok(Located {
                cli: PathBuf::from("/bin/hr"),
                source: Source::Path,
            })
        );
    }

    #[test]
    fn ac6_missing_explicit_path_does_not_fall_back() {
        let exists = only_these(&["/bin/hr"]);
        assert_eq!(
            locate(Some(Path::new("/nope/hr")), None, Some("/bin"), &exists),
            Err(LocateError::ExplicitMissing(PathBuf::from("/nope/hr")))
        );
    }

    #[test]
    fn ac6_all_three_missing_is_not_found() {
        let exists = only_these(&[]);
        assert_eq!(
            locate(
                None,
                Some(Path::new("/nope/hr")),
                Some("/usr/bin:/bin"),
                &exists
            ),
            Err(LocateError::NotFound)
        );
        assert_eq!(
            locate(None, None, None, &exists),
            Err(LocateError::NotFound)
        );
    }

    #[test]
    fn ac6_empty_path_entries_are_skipped() {
        let exists = only_these(&["/bin/hr"]);
        assert_eq!(
            locate(None, None, Some("::/bin::"), &exists),
            Ok(Located {
                cli: PathBuf::from("/bin/hr"),
                source: Source::Path,
            })
        );
    }
}
