//! `hr` CLI 的三级定位：`--cli-path` > `HREADER_CLI` > `PATH`（纯决策，存在性判定由调用方注入）。

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

use which::sys::{Sys, SysMetadata, SysReadDirEntry};
use which::WhichConfig;

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

struct InjectedMetadata {
    is_file: bool,
}

impl SysMetadata for InjectedMetadata {
    fn is_symlink(&self) -> bool {
        false
    }

    fn is_file(&self) -> bool {
        self.is_file
    }
}

struct EmptyDirEntry;

impl SysReadDirEntry for EmptyDirEntry {
    fn file_name(&self) -> OsString {
        OsString::new()
    }

    fn path(&self) -> PathBuf {
        PathBuf::new()
    }
}

/// 将调用方注入的 `exists` 判定适配为 `which::sys::Sys`，在保持纯函数可测性的前提下复用 `which` 的 PATH 查找。
struct InjectedSys<'a> {
    exists: &'a dyn Fn(&Path) -> bool,
}

impl Sys for InjectedSys<'_> {
    type ReadDirEntry = EmptyDirEntry;
    type Metadata = InjectedMetadata;

    fn is_windows(&self) -> bool {
        cfg!(windows)
    }

    fn current_dir(&self) -> io::Result<PathBuf> {
        Err(io::Error::new(io::ErrorKind::NotFound, "unused"))
    }

    fn home_dir(&self) -> Option<PathBuf> {
        None
    }

    fn env_split_paths(&self, paths: &OsStr) -> Vec<PathBuf> {
        std::env::split_paths(paths)
            .filter(|dir| !dir.as_os_str().is_empty())
            .collect()
    }

    fn env_path(&self) -> Option<OsString> {
        None
    }

    fn env_path_ext(&self) -> Option<OsString> {
        if cfg!(windows) {
            Some(OsString::from(".CMD;.EXE"))
        } else {
            None
        }
    }

    fn metadata(&self, path: &Path) -> io::Result<Self::Metadata> {
        Ok(InjectedMetadata {
            is_file: (self.exists)(path),
        })
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<Self::Metadata> {
        self.metadata(path)
    }

    fn read_dir(
        &self,
        _path: &Path,
    ) -> io::Result<Box<dyn Iterator<Item = io::Result<Self::ReadDirEntry>>>> {
        Ok(Box::new(std::iter::empty()))
    }

    fn is_valid_executable(&self, path: &Path) -> io::Result<bool> {
        Ok((self.exists)(path))
    }
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
    let Some(path_list) = path_var else {
        return Err(LocateError::NotFound);
    };
    let found = WhichConfig::new_with_sys(InjectedSys { exists })
        .binary_name(OsString::from("hr"))
        .custom_path_list(OsString::from(path_list))
        .system_cwd(false)
        .all_results()
        .ok()
        .and_then(|mut iter| iter.next());
    match found {
        Some(cli) => Ok(Located {
            cli,
            source: Source::Path,
        }),
        None => Err(LocateError::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn only_these(paths: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |candidate: &Path| paths.iter().any(|known| Path::new(known) == candidate)
    }

    #[test]
    fn flag_wins_over_env_and_path() {
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
    fn env_wins_over_path() {
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
    fn path_is_the_last_resort() {
        let exists = only_these(&["/bin/hr"]);
        let path_env = if cfg!(windows) {
            "/usr/bin;/bin"
        } else {
            "/usr/bin:/bin"
        };
        assert_eq!(
            locate(None, None, Some(path_env), &exists),
            Ok(Located {
                cli: PathBuf::from("/bin/hr"),
                source: Source::Path,
            })
        );
    }

    #[test]
    fn missing_explicit_path_does_not_fall_back() {
        let exists = only_these(&["/bin/hr"]);
        assert_eq!(
            locate(Some(Path::new("/nope/hr")), None, Some("/bin"), &exists),
            Err(LocateError::ExplicitMissing(PathBuf::from("/nope/hr")))
        );
    }

    #[test]
    fn all_three_missing_is_not_found() {
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
    fn empty_path_entries_are_skipped() {
        let exists = only_these(&["/bin/hr"]);
        let path_env = if cfg!(windows) {
            ";;/bin;;"
        } else {
            "::/bin::"
        };
        assert_eq!(
            locate(None, None, Some(path_env), &exists),
            Ok(Located {
                cli: PathBuf::from("/bin/hr"),
                source: Source::Path,
            })
        );
    }
}
