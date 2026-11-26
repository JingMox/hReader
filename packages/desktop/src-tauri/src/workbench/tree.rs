//! 工作区目录树扫描：递归收集目录与 `.html`/`.htm` 文档，跳过隐藏目录与构建产物。
//!
//! Asset folding (D10): a page's assets are its same-named `<name>_files/` or
//! `<name>.assets/` directory, and — when a directory contains exactly one HTML
//! file — every other entry in that directory. Asset-attaching only happens for
//! subdirectories that are `clean` (fully scanned and containing no HTML of
//! their own). A directory whose sole document is `index.html` collapses into a
//! single `page-folder` node.

use std::cmp::Ordering;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_TREE_DEPTH: usize = 8;
const MAX_TREE_NODES: usize = 2000;
/// `<title>` lives in `<head>`; a bounded prefix keeps scanning linear even
/// when every folded page-folder points at a multi-MB HTML file.
const TITLE_SCAN_LIMIT: u64 = 64 * 1024;

/// 左侧文件树节点类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TreeEntryKind {
    Dir,
    File,
    /// A directory that contains exactly `index.html` plus its assets; it is
    /// rendered as one page entry instead of an expandable folder.
    #[serde(rename = "page-folder")]
    PageFolder,
}

/// 左侧工作区目录树节点（支持任意层级嵌套文件夹与 HTML 笔记）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: TreeEntryKind,
    pub children: Vec<TreeNode>,
    /// Entries hidden in the default view: for a page/page-folder these are its
    /// resources, listed under the expandable marker; never openable documents.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<TreeNode>,
    /// `page-folder` display label: the index page's `<title>`, when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `page-folder`: workspace-relative path of the `index.html` it opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    /// `true` = a non-HTML file node: shown only under "show all files" or inside
    /// an asset listing, and opens with the system default application.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
}

fn is_false(v: &bool) -> bool {
    !*v
}

fn should_skip_entry_name(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist")
}

fn join_rel(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Traversal counters: `remaining` is the node budget; `dirs_read` and
/// `entries_seen` exist so tests can prove every directory is visited once.
#[derive(Debug, Default)]
struct ScanBudget {
    remaining: usize,
    dirs_read: usize,
    entries_seen: usize,
}

/// What a scanned directory contributes to its parent. `clean` means "fully
/// scanned and no HTML found anywhere inside" — the only condition under which
/// a directory may fold into a page's `assets` (unreadable or budget-truncated
/// directories are never claimed).
#[derive(Debug, Default)]
struct DirScan {
    node: Option<TreeNode>,
    clean: bool,
}

/// 递归扫描工作区，返回按「文件夹优先 + 字母序」排列的嵌套目录树（仅包含目录与 `.html`/`.htm` 文件）。
pub fn scan_workspace_tree(workspace: &Path) -> Vec<TreeNode> {
    scan_workspace_tree_stats(workspace).0
}

fn scan_workspace_tree_stats(workspace: &Path) -> (Vec<TreeNode>, ScanBudget) {
    let mut budget = ScanBudget {
        remaining: MAX_TREE_NODES,
        ..ScanBudget::default()
    };
    let scan = scan_dir(workspace, "", 0, &mut budget);
    let tree = match scan.node {
        // A workspace root that is itself a foldable page directory collapses
        // to one entry; otherwise the root's contents are the top-level list.
        Some(node) if node.kind == TreeEntryKind::PageFolder => vec![node],
        Some(node) => node.children,
        None => Vec::new(),
    };
    (tree, budget)
}

fn dir_name_of(path: &Path, rel: &str) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| rel.to_string())
}

fn dir_node(name: String, rel: String, children: Vec<TreeNode>) -> TreeNode {
    TreeNode {
        name,
        path: rel,
        kind: TreeEntryKind::Dir,
        children,
        assets: Vec::new(),
        title: None,
        entry: None,
        hidden: false,
    }
}

fn file_node(name: String, rel: String, hidden: bool, assets: Vec<TreeNode>) -> TreeNode {
    TreeNode {
        name,
        path: rel,
        kind: TreeEntryKind::File,
        children: Vec::new(),
        assets,
        title: None,
        entry: None,
        hidden,
    }
}

fn is_index_page(name: &str) -> bool {
    name.eq_ignore_ascii_case("index.html") || name.eq_ignore_ascii_case("index.htm")
}

/// `<stem>_files` / `<stem>.assets` (case-insensitive) -> `<stem>`; the stem must
/// be non-empty, so `a_files` matches `a.html` but bare `_files` matches nothing.
fn asset_dir_stem(name: &str) -> Option<&str> {
    for suffix in ["_files", ".assets"] {
        if name.len() > suffix.len()
            && name[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
        {
            return Some(&name[..name.len() - suffix.len()]);
        }
    }
    None
}

fn file_stem_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(pos) => &name[..pos],
        None => name,
    }
}

fn find_ascii_ci(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|w| w.eq_ignore_ascii_case(needle))
        .map(|pos| pos + from)
}

fn decode_title_entities(raw: &str) -> String {
    raw.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

/// Best-effort `<title>` extraction for a folded page directory: bounded read,
/// ASCII-case-insensitive tag scan, entity decode, whitespace collapse.
fn html_page_title(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(TITLE_SCAN_LIMIT).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let bytes = text.as_bytes();
    // `<title` may also prefix `<titlex>`; require a tag delimiter right after.
    let mut from = 0;
    let open = loop {
        let idx = find_ascii_ci(bytes, b"<title", from)?;
        match bytes.get(idx + 6) {
            None | Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
            | Some(b'/') => break idx,
            _ => from = idx + 6,
        }
    };
    let open_end = find_ascii_ci(bytes, b">", open)?;
    let close = find_ascii_ci(bytes, b"</title", open_end + 1)?;
    let title = decode_title_entities(&text[open_end + 1..close])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

fn scan_dir(dir: &Path, rel: &str, depth: usize, budget: &mut ScanBudget) -> DirScan {
    let truncated = || DirScan {
        node: Some(dir_node(dir_name_of(dir, rel), rel.to_string(), Vec::new())),
        clean: false,
    };
    if depth >= MAX_TREE_DEPTH || budget.remaining == 0 {
        return truncated();
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return truncated();
    };
    budget.dirs_read += 1;

    let mut subdirs: Vec<(String, PathBuf, String)> = Vec::new();
    let mut html_files: Vec<(String, PathBuf, String)> = Vec::new();
    let mut other_files: Vec<(String, String)> = Vec::new();
    for entry in entries.flatten() {
        budget.entries_seen += 1;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if should_skip_entry_name(&name) {
            continue;
        }
        let path = entry.path();
        let entry_rel = join_rel(rel, &name);
        if path.is_dir() {
            subdirs.push((name, path, entry_rel));
        } else if path.is_file() {
            if is_html_file(&path) {
                html_files.push((name, path, entry_rel));
            } else {
                other_files.push((name, entry_rel));
            }
        }
    }
    // Deterministic claim order: when two pages share a stem (a.html/a.htm),
    // the alphabetically-first page wins the named asset directory.
    html_files.sort_by(|a, b| {
        a.0.to_lowercase()
            .cmp(&b.0.to_lowercase())
            .then_with(|| a.0.cmp(&b.0))
    });

    // Each subdirectory is scanned exactly once; the emitted node is then
    // either kept as a child or moved into a page's asset list.
    let mut scanned: Vec<DirScan> = Vec::with_capacity(subdirs.len());
    let mut sub_names: Vec<String> = Vec::with_capacity(subdirs.len());
    let mut complete = true;
    for (name, path, entry_rel) in subdirs {
        if budget.remaining == 0 {
            complete = false;
            break;
        }
        budget.remaining -= 1;
        sub_names.push(name);
        scanned.push(scan_dir(&path, &entry_rel, depth + 1, budget));
    }
    let all_subs_clean = scanned.iter().all(|s| s.clean);

    let mut children: Vec<TreeNode> = Vec::new();
    let html_count = html_files.len();
    if html_count == 1 {
        // D10 rule 2: the sole HTML file claims every other entry, provided a
        // claimed subdirectory is `clean` (no HTML of its own, fully scanned).
        let (name, path, entry_rel) = html_files.swap_remove(0);
        let mut page_assets: Vec<TreeNode> = Vec::new();
        for scan in scanned {
            match scan.node {
                Some(node) if scan.clean => page_assets.push(node),
                Some(node) => children.push(node),
                None => {}
            }
        }
        for (fname, frel) in other_files {
            if budget.remaining == 0 {
                complete = false;
                break;
            }
            budget.remaining -= 1;
            page_assets.push(file_node(fname, frel, true, Vec::new()));
        }
        page_assets.sort_by(compare_tree_nodes);
        if budget.remaining == 0 {
            complete = false;
        } else {
            budget.remaining -= 1;
            if is_index_page(&name) && children.is_empty() {
                // The whole directory is one page plus its resources: collapse it.
                let page = file_node(name, entry_rel.clone(), false, Vec::new());
                return DirScan {
                    node: Some(TreeNode {
                        name: dir_name_of(dir, rel),
                        path: rel.to_string(),
                        kind: TreeEntryKind::PageFolder,
                        children: vec![page],
                        assets: page_assets,
                        title: html_page_title(&path),
                        entry: Some(entry_rel),
                        hidden: false,
                    }),
                    clean: false,
                };
            }
            children.push(file_node(name, entry_rel, false, page_assets));
        }
    } else {
        // 0 or 2+ HTML files: named `<stem>_files`/`<stem>.assets` directories
        // still fold into their page; everything else keeps its place.
        let mut sub_owner: Vec<Option<usize>> = vec![None; scanned.len()];
        for (hidx, (name, _path, _rel)) in html_files.iter().enumerate() {
            let stem = file_stem_of(name);
            for (idx, scan) in scanned.iter().enumerate() {
                if sub_owner[idx].is_none()
                    && scan.clean
                    && asset_dir_stem(&sub_names[idx]).is_some_and(|s| s.eq_ignore_ascii_case(stem))
                {
                    sub_owner[idx] = Some(hidx);
                }
            }
        }
        for (hidx, (name, _path, entry_rel)) in html_files.iter().enumerate() {
            if budget.remaining == 0 {
                complete = false;
                break;
            }
            budget.remaining -= 1;
            let mut page_assets: Vec<TreeNode> = Vec::new();
            for (idx, scan) in scanned.iter_mut().enumerate() {
                if sub_owner[idx] == Some(hidx) {
                    if let Some(node) = scan.node.take() {
                        page_assets.push(node);
                    }
                }
            }
            page_assets.sort_by(compare_tree_nodes);
            children.push(file_node(
                name.clone(),
                entry_rel.clone(),
                false,
                page_assets,
            ));
        }
        for scan in scanned {
            if let Some(node) = scan.node {
                children.push(node);
            }
        }
        for (fname, frel) in other_files {
            if budget.remaining == 0 {
                complete = false;
                break;
            }
            budget.remaining -= 1;
            children.push(file_node(fname, frel, true, Vec::new()));
        }
    }

    children.sort_by(compare_tree_nodes);
    let clean = complete && html_count == 0 && all_subs_clean;
    DirScan {
        node: Some(dir_node(dir_name_of(dir, rel), rel.to_string(), children)),
        clean,
    }
}

fn compare_tree_nodes(a: &TreeNode, b: &TreeNode) -> Ordering {
    let rank = |k: TreeEntryKind| match k {
        TreeEntryKind::Dir => 0u8,
        // A folded page directory renders as a document entry, not a folder.
        TreeEntryKind::PageFolder | TreeEntryKind::File => 1u8,
    };
    rank(a.kind)
        .cmp(&rank(b.kind))
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

fn collect_files_from_tree(nodes: &[TreeNode], out: &mut Vec<String>) {
    for node in nodes {
        if node.hidden {
            continue;
        }
        match node.kind {
            TreeEntryKind::Dir | TreeEntryKind::PageFolder => {
                collect_files_from_tree(&node.children, out);
            }
            TreeEntryKind::File => out.push(node.path.clone()),
        }
        // Pages carry resources in `assets`; an HTML file must never hide there,
        // but recurse defensively so a contract slip cannot drop a document.
        collect_files_from_tree(&node.assets, out);
    }
}

/// 枚举工作区内所有嵌套子目录下的 `.html`/`.htm` 文档相对路径（排序返回）。
pub fn list_html_files(workspace: &Path) -> Vec<String> {
    let tree = scan_workspace_tree(workspace);
    let mut files = Vec::new();
    collect_files_from_tree(&tree, &mut files);
    files.sort();
    files
}

pub fn is_html_file(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
    })
}

