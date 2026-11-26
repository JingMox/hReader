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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_ws(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hr-wb-tree-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write(path: &Path) {
        fs::write(path, "<p>x</p>").expect("write file");
    }

    fn tree_names(nodes: &[TreeNode]) -> Vec<&str> {
        nodes.iter().map(|n| n.name.as_str()).collect()
    }

    #[test]
    fn list_html_files_filters_hidden_and_sorts() {
        let dir = temp_ws("files");
        fs::create_dir_all(dir.join(".hreader")).expect("dot dir");
        fs::create_dir_all(dir.join("notes")).expect("notes dir");
        fs::write(dir.join(".hreader/internal.html"), "").expect("write dot");
        fs::write(dir.join("b.html"), "").expect("write b");
        fs::write(dir.join("a.htm"), "").expect("write a");
        fs::write(dir.join("ignore.txt"), "").expect("write txt");
        fs::write(dir.join("notes/sub.html"), "").expect("write sub");

        let found = list_html_files(&dir);
        assert_eq!(found, vec!["a.htm", "b.html", "notes/sub.html"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// D10 rule 2: a directory with a single HTML file folds every other entry
    /// (HTML-free subdirectories included) into that page's assets.
    #[test]
    fn single_html_dir_folds_siblings_into_page_assets() {
        let dir = temp_ws("tree");
        fs::create_dir_all(dir.join("system/paper/deep")).expect("deep dir");
        fs::create_dir_all(dir.join("empty_folder")).expect("empty dir");
        fs::create_dir_all(dir.join(".hidden_dir")).expect("hidden dir");
        fs::create_dir_all(dir.join("node_modules/pkg")).expect("node_modules dir");
        fs::write(dir.join("root.html"), "").expect("root html");
        fs::write(dir.join("readme.txt"), "").expect("txt");
        fs::write(dir.join("system/paper/deep/note.html"), "").expect("deep note");
        fs::write(dir.join("node_modules/pkg/skip.html"), "").expect("skip nm");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["system", "root.html"]);
        // `system` still holds an HTML page -> normal directory child.
        assert_eq!(tree[0].kind, TreeEntryKind::Dir);
        assert_eq!(tree[0].children[0].name, "paper");
        assert_eq!(tree[0].children[0].children[0].name, "deep");
        assert_eq!(
            tree[0].children[0].children[0].children[0].path,
            "system/paper/deep/note.html"
        );
        // `empty_folder` and `readme.txt` are HTML-free -> page assets.
        assert_eq!(tree[1].kind, TreeEntryKind::File);
        assert_eq!(
            tree_names(&tree[1].assets),
            vec!["empty_folder", "readme.txt"]
        );
        assert_eq!(tree[1].assets[0].kind, TreeEntryKind::Dir);
        assert!(tree[1].assets[1].hidden);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn browser_save_as_dir_folds_into_matching_page() {
        let dir = temp_ws("save-as");
        write(&dir.join("a.html"));
        write(&dir.join("b.html"));
        fs::create_dir_all(dir.join("a_files/img")).expect("a_files");
        fs::write(dir.join("a_files/style.css"), "css").expect("css");
        fs::write(dir.join("a_files/img/logo.png"), "png").expect("png");
        fs::create_dir_all(dir.join("b_files")).expect("b_files");
        fs::write(dir.join("b_files/x.css"), "css").expect("b css");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["a.html", "b.html"]);
        let (a, b) = (&tree[0], &tree[1]);
        assert_eq!(tree_names(&a.assets), vec!["a_files"]);
        assert_eq!(a.assets[0].kind, TreeEntryKind::Dir);
        assert_eq!(tree_names(&a.assets[0].children), vec!["img", "style.css"]);
        assert!(a.assets[0].children[1].hidden);
        assert_eq!(tree_names(&b.assets), vec!["b_files"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dot_assets_dir_folds_into_matching_page() {
        let dir = temp_ws("dot-assets");
        write(&dir.join("a.html"));
        write(&dir.join("b.html"));
        fs::create_dir_all(dir.join("a.assets")).expect("a.assets");
        fs::write(dir.join("a.assets/app.js"), "js").expect("js");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["a.html", "b.html"]);
        assert_eq!(tree_names(&tree[0].assets), vec!["a.assets"]);
        assert!(tree[1].assets.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unclaimed_named_dir_stays_a_normal_child() {
        let dir = temp_ws("unclaimed");
        write(&dir.join("a.html"));
        write(&dir.join("b.html"));
        // `c_files` belongs to no page; it remains a visible directory.
        fs::create_dir_all(dir.join("c_files")).expect("c_files");
        fs::write(dir.join("c_files/x.css"), "css").expect("css");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["c_files", "a.html", "b.html"]);
        assert_eq!(tree[0].kind, TreeEntryKind::Dir);
        assert!(tree[1].assets.is_empty());
        assert!(tree[2].assets.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// A directory whose only document is `index.html` collapses to one
    /// page-folder entry titled by `<title>`; the rest are its assets.
    #[test]
    fn index_only_dir_collapses_into_page_folder() {
        let dir = temp_ws("page-folder");
        fs::create_dir_all(dir.join("site/assets/css")).expect("nested assets");
        fs::write(
            dir.join("site/index.html"),
            "<html><head><title>  My&nbsp;Page &amp; More </title></head></html>",
        )
        .expect("index");
        fs::write(dir.join("site/assets/css/main.css"), "css").expect("css");
        fs::write(dir.join("site/pic.png"), "png").expect("png");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree.len(), 1);
        let node = &tree[0];
        assert_eq!(node.kind, TreeEntryKind::PageFolder);
        assert_eq!(node.name, "site");
        assert_eq!(node.path, "site");
        assert_eq!(node.title.as_deref(), Some("My Page & More"));
        assert_eq!(node.entry.as_deref(), Some("site/index.html"));
        assert_eq!(tree_names(&node.assets), vec!["assets", "pic.png"]);
        assert_eq!(node.children.len(), 1);
        assert_eq!(node.children[0].path, "site/index.html");
        assert_eq!(list_html_files(&dir), vec!["site/index.html"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn index_htm_also_collapses_and_missing_title_falls_back() {
        let dir = temp_ws("index-htm");
        fs::create_dir_all(dir.join("bare")).expect("bare");
        // No <title> in the file -> the page-folder label is the directory name.
        fs::write(dir.join("bare/INDEX.HTM"), "<p>no title</p>").expect("index");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].kind, TreeEntryKind::PageFolder);
        assert_eq!(tree[0].name, "bare");
        assert_eq!(tree[0].title, None);
        assert_eq!(tree[0].entry.as_deref(), Some("bare/INDEX.HTM"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_with_single_non_index_html_does_not_collapse() {
        let dir = temp_ws("no-fold");
        fs::create_dir_all(dir.join("doc/img")).expect("img dir");
        fs::write(dir.join("doc/note.html"), "<title>T</title>").expect("note");
        fs::write(dir.join("doc/img/p.png"), "png").expect("png");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["doc"]);
        let doc = &tree[0];
        assert_eq!(doc.kind, TreeEntryKind::Dir);
        assert_eq!(doc.children.len(), 1);
        let page = &doc.children[0];
        assert_eq!(page.kind, TreeEntryKind::File);
        assert_eq!(page.path, "doc/note.html");
        assert_eq!(tree_names(&page.assets), vec!["img"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A subdirectory that itself contains HTML blocks folding: the parent can
    /// no longer prove "everything else is resources", so it stays a directory.
    #[test]
    fn index_dir_with_html_bearing_subdir_stays_expanded() {
        let dir = temp_ws("mixed");
        fs::create_dir_all(dir.join("d/sub")).expect("sub");
        fs::write(dir.join("d/index.html"), "<title>T</title>").expect("index");
        fs::write(dir.join("d/sub/other.html"), "").expect("other");
        fs::write(dir.join("d/logo.png"), "png").expect("png");

        let tree = scan_workspace_tree(&dir);
        let d = &tree[0];
        assert_eq!(d.kind, TreeEntryKind::Dir);
        assert_eq!(tree_names(&d.children), vec!["sub", "index.html"]);
        let index = &d.children[1];
        // `logo.png` still folds into the page's own assets.
        assert_eq!(tree_names(&index.assets), vec!["logo.png"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A `_files` directory containing HTML is not an asset dir: its document
    /// stays reachable in the tree.
    #[test]
    fn files_dir_containing_html_is_not_folded_as_asset() {
        let dir = temp_ws("files-html");
        write(&dir.join("a.html"));
        write(&dir.join("b.html"));
        fs::create_dir_all(dir.join("a_files")).expect("a_files");
        fs::write(dir.join("a_files/inner.html"), "<title>I</title>").expect("inner");

        let tree = scan_workspace_tree(&dir);
        // Directories sort before files: a_files, then the two pages.
        assert_eq!(tree_names(&tree), vec!["a_files", "a.html", "b.html"]);
        assert!(tree[1].assets.is_empty());
        // `a_files` holds only inner.html (non-index) -> normal directory.
        assert_eq!(tree[0].kind, TreeEntryKind::Dir);
        assert_eq!(tree_names(&tree[0].children), vec!["inner.html"]);
        assert_eq!(
            list_html_files(&dir),
            vec!["a.html", "a_files/inner.html", "b.html"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Case-insensitive matching covers macOS's case-insensitive filesystem:
    /// `Report_Files` belongs to `report.html`, `A.ASSETS` to `a.html`.
    #[test]
    fn asset_dir_matching_is_case_insensitive() {
        let dir = temp_ws("case");
        write(&dir.join("a.html"));
        write(&dir.join("report.html"));
        fs::create_dir_all(dir.join("Report_Files")).expect("Report_Files");
        fs::write(dir.join("Report_Files/x.png"), "png").expect("png");
        fs::create_dir_all(dir.join("A.ASSETS")).expect("A.ASSETS");
        fs::write(dir.join("A.ASSETS/y.css"), "css").expect("css");

        let tree = scan_workspace_tree(&dir);
        let by_name = |n: &str| tree.iter().find(|t| t.name == n).expect(n);
        assert_eq!(
            tree_names(&by_name("report.html").assets),
            vec!["Report_Files"]
        );
        assert_eq!(tree_names(&by_name("a.html").assets), vec!["A.ASSETS"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unicode_and_spaced_names_fold_normally() {
        let dir = temp_ws("unicode");
        fs::write(dir.join("中文 页面 🚀.html"), "").expect("page");
        fs::write(dir.join("另一页.html"), "").expect("other");
        fs::create_dir_all(dir.join("中文 页面 🚀_files")).expect("assets dir");
        fs::write(dir.join("中文 页面 🚀_files/图片 📷.png"), "png").expect("png");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["中文 页面 🚀.html", "另一页.html"]);
        let page = &tree[0];
        assert_eq!(tree_names(&page.assets), vec!["中文 页面 🚀_files"]);
        assert_eq!(page.assets[0].children[0].name, "图片 📷.png");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_directories_and_empty_workspace_scan_cleanly() {
        let dir = temp_ws("empty");
        fs::create_dir_all(dir.join("empty_folder")).expect("empty");
        fs::create_dir_all(dir.join("pages")).expect("pages");
        fs::write(dir.join("pages/a.html"), "").expect("a");
        fs::write(dir.join("pages/b.html"), "").expect("b");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["empty_folder", "pages"]);
        assert_eq!(tree[0].kind, TreeEntryKind::Dir);
        assert!(tree[0].children.is_empty());
        let _ = fs::remove_dir_all(&dir);

        let bare = temp_ws("bare");
        assert!(scan_workspace_tree(&bare).is_empty());
        let _ = fs::remove_dir_all(&bare);
    }

    #[test]
    fn depth_cap_truncates_deep_directories() {
        let dir = temp_ws("depth");
        // 10-level chain; an HTML file at level 7 (visible) and 9 (beyond cap).
        let mut p = dir.clone();
        for i in 1..=10 {
            p = p.join(format!("d{i}"));
        }
        fs::create_dir_all(&p).expect("deep chain");
        fs::write(dir.join("d1/d2/d3/d4/d5/d6/d7/visible.html"), "").expect("visible");
        fs::write(dir.join("d1/d2/d3/d4/d5/d6/d7/d8/d9/too_deep.html"), "").expect("deep");

        let tree = scan_workspace_tree(&dir);
        let mut node = &tree[0];
        assert_eq!(node.name, "d1");
        for expected in ["d2", "d3", "d4", "d5", "d6", "d7"] {
            let next = node
                .children
                .iter()
                .find(|n| n.kind == TreeEntryKind::Dir)
                .expect("next level");
            assert_eq!(next.name, expected);
            node = next;
        }
        // d7 carries the visible page plus the capped d8 directory.
        assert_eq!(tree_names(&node.children), vec!["d8", "visible.html"]);
        assert!(node.children[0].children.is_empty());
        assert_eq!(
            list_html_files(&dir),
            vec!["d1/d2/d3/d4/d5/d6/d7/visible.html"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn node_budget_truncates_flat_file_lists() {
        let dir = temp_ws("budget");
        for i in 0..2100 {
            fs::write(dir.join(format!("f{i:04}.html")), "").expect("html");
        }
        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree.len(), MAX_TREE_NODES);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Symlinks are never followed (watcher parity: `followSymlinks: false`):
    /// a link pointing outside the workspace becomes a hidden leaf, never a
    /// directory the scan descends into.
    #[cfg(unix)]
    #[test]
    fn symlinked_dirs_are_not_followed() {
        let dir = temp_ws("symlink-out");
        let outside = std::env::temp_dir().join(format!("hr-wb-out-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("external.html"), "").expect("external");
        fs::write(outside.join("res.png"), "png").expect("png");
        write(&dir.join("a.html"));
        write(&dir.join("b.html"));
        std::os::unix::fs::symlink(&outside, dir.join("linked")).expect("symlink");

        let tree = scan_workspace_tree(&dir);
        // `linked` is a non-document leaf: hidden by default, no children, and
        // the outside directory's HTML never enters the tree.
        assert_eq!(tree_names(&tree), vec!["a.html", "b.html", "linked"]);
        let linked = &tree[2];
        assert_eq!(linked.kind, TreeEntryKind::File);
        assert!(linked.hidden);
        assert!(linked.children.is_empty());
        assert_eq!(list_html_files(&dir), vec!["a.html", "b.html"]);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    /// A symlink loop cannot recurse at all: the link is a leaf, so the scan
    /// terminates immediately instead of chasing the cycle to the depth cap.
    #[cfg(unix)]
    #[test]
    fn symlink_cycle_is_a_leaf_not_a_recursion() {
        let dir = temp_ws("symlink-loop");
        write(&dir.join("a.html"));
        write(&dir.join("b.html"));
        std::os::unix::fs::symlink(".", dir.join("loop")).expect("symlink loop");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["a.html", "b.html", "loop"]);
        let node = &tree[2];
        assert_eq!(node.kind, TreeEntryKind::File);
        assert!(node.hidden);
        assert!(node.children.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Even a link pointing back *inside* the workspace is not followed: the
    /// rule is uniform (the bridge re-verifies the real path at open time).
    #[cfg(unix)]
    #[test]
    fn inside_pointing_symlink_is_also_a_leaf() {
        let dir = temp_ws("symlink-in");
        fs::create_dir_all(dir.join("real")).expect("real dir");
        fs::write(dir.join("real/doc.html"), "").expect("doc");
        write(&dir.join("a.html"));
        write(&dir.join("b.html"));
        std::os::unix::fs::symlink(dir.join("real"), dir.join("alias")).expect("link");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["real", "a.html", "alias", "b.html"]);
        let alias = &tree[2];
        assert_eq!(alias.kind, TreeEntryKind::File);
        assert!(alias.hidden);
        assert!(alias.children.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// A symlinked `.html` file is a leaf too — it must not appear as an
    /// openable document (the watcher would not follow it either).
    #[cfg(unix)]
    #[test]
    fn symlinked_html_file_is_not_a_document() {
        let dir = temp_ws("symlink-html");
        let outside = std::env::temp_dir().join(format!("hr-wb-outhtml-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).expect("outside");
        fs::write(outside.join("external.html"), "").expect("external");
        write(&dir.join("a.html"));
        write(&dir.join("b.html"));
        std::os::unix::fs::symlink(outside.join("external.html"), dir.join("linked.html"))
            .expect("html link");

        let tree = scan_workspace_tree(&dir);
        assert_eq!(tree_names(&tree), vec!["a.html", "b.html", "linked.html"]);
        let node = &tree[2];
        assert_eq!(node.kind, TreeEntryKind::File);
        assert!(node.hidden);
        assert_eq!(list_html_files(&dir), vec!["a.html", "b.html"]);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn every_directory_is_scanned_exactly_once() {
        let dir = temp_ws("linear");
        // Three foldable page-folders plus a plain multi-HTML directory.
        for i in 0..3 {
            let site = dir.join(format!("site{i}"));
            fs::create_dir_all(site.join("assets")).expect("assets");
            fs::write(site.join("index.html"), "<title>T</title>").expect("index");
            fs::write(site.join("assets/a.css"), "css").expect("css");
        }
        fs::create_dir_all(dir.join("multi")).expect("multi");
        fs::write(dir.join("multi/a.html"), "").expect("a");
        fs::write(dir.join("multi/b.html"), "").expect("b");
        write(&dir.join("root1.html"));
        write(&dir.join("root2.html"));

        let (tree, stats) = scan_workspace_tree_stats(&dir);
        // dirs read: root + 3 page dirs + 3 asset dirs + multi = 8.
        assert_eq!(stats.dirs_read, 8);
        // entries: root(6) + 3*2 + 3*1 + multi(2) = 17.
        assert_eq!(stats.entries_seen, 17);
        assert_eq!(
            tree_names(&tree),
            vec![
                "multi",
                "root1.html",
                "root2.html",
                "site0",
                "site1",
                "site2"
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Scale test: ~3000 files across 100 dirs plus a 30-level chain.
    /// Node output stays capped and traversal counters prove linearity —
    /// every directory is read at most once, never revisited.
    #[test]
    fn large_workspace_stays_capped_and_scans_each_dir_once() {
        let dir = temp_ws("large");
        for i in 0..90 {
            let d = dir.join(format!("pack{i:02}"));
            fs::create_dir_all(&d).expect("pack dir");
            for j in 0..15 {
                let name = if j == 0 {
                    format!("p{i:02}-doc{j}.html")
                } else {
                    format!("f{i:02}-{j}.dat")
                };
                fs::write(d.join(name), "x").expect("file");
            }
        }
        for i in 0..10 {
            let site = dir.join(format!("site{i:02}"));
            fs::create_dir_all(site.join("res")).expect("site res");
            fs::write(site.join("index.html"), "<title>x</title>").expect("index");
            for j in 0..14 {
                fs::write(site.join(format!("res/r{j}.png")), "png").expect("png");
            }
        }
        // 30-level chain; only levels within the depth cap are scanned.
        let mut chain = dir.clone();
        for i in 1..=30 {
            chain = chain.join(format!("l{i}"));
        }
        fs::create_dir_all(&chain).expect("chain");
        fs::write(dir.join("l1/l2/l3/l4/l5/l6/l7/deep.html"), "").expect("deep");

        let (tree, stats) = scan_workspace_tree_stats(&dir);
        fn count_nodes(nodes: &[TreeNode]) -> usize {
            nodes
                .iter()
                .map(|n| 1 + count_nodes(&n.children) + count_nodes(&n.assets))
                .sum()
        }
        let total = count_nodes(&tree);
        assert!(total <= MAX_TREE_NODES, "node cap exceeded: {total}");
        // Linearity: a directory is read at most once; entries are counted per
        // single visit, so both counters stay below the created filesystem size.
        //   dirs:  root 1 + packs 90 + sites/res 20 + chain 30 = 141 max
        //   items: root 101 + packs 1350 + sites 20 + res 140 + chain 8 = 1619
        assert!(stats.dirs_read <= 141, "dirs_read={}", stats.dirs_read);
        assert!(
            stats.entries_seen <= 1619,
            "entries_seen={}",
            stats.entries_seen
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn medium_tree_reads_each_dir_and_entry_exactly_once() {
        let dir = temp_ws("medium");
        // 100 dirs x 15 files = 1600 nodes: everything fits the budget, so the
        // counters must equal the created filesystem shape exactly.
        for i in 0..100 {
            let d = dir.join(format!("g{i:03}"));
            fs::create_dir_all(&d).expect("group dir");
            for j in 0..15 {
                fs::write(d.join(format!("f{j}.dat")), "x").expect("dat");
            }
        }
        let (tree, stats) = scan_workspace_tree_stats(&dir);
        assert_eq!(tree.len(), 100);
        // 100 group dirs + root.
        assert_eq!(stats.dirs_read, 101);
        // root sees 100 entries; each group sees 15.
        assert_eq!(stats.entries_seen, 100 + 100 * 15);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_title_extraction_handles_variants() {
        let dir = temp_ws("title");
        let cases: [(&str, &str, Option<&str>); 10] = [
            ("plain", "<title>Hello</title>", Some("Hello")),
            ("attrs", "<title lang=\"en\">Hi</title>", Some("Hi")),
            ("upper", "<TITLE>UP</TITLE>", Some("UP")),
            ("entity", "<title>a &amp; b</title>", Some("a & b")),
            ("nbsp", "<title>x&nbsp;y</title>", Some("x y")),
            ("ws", "<title>  a\n  b\t c  </title>", Some("a b c")),
            ("empty", "<title>   </title>", None),
            ("none", "<p>no title</p>", None),
            ("unclosed", "<title>never", None),
            (
                "prefix",
                "<titlex>not</titlex><title>ok</title>",
                Some("ok"),
            ),
        ];
        for (name, html, expected) in cases {
            let p = dir.join(format!("{name}.html"));
            fs::write(&p, html).expect("write");
            assert_eq!(html_page_title(&p).as_deref(), expected, "{name}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_title_handles_non_utf8_and_skips_late_titles() {
        let dir = temp_ws("title-edge");
        let bad = dir.join("bad.html");
        fs::write(&bad, b"<title>caf\xE9</title>").expect("latin1");
        // Invalid UTF-8 degrades to a replacement char but still yields a title.
        assert!(html_page_title(&bad).is_some());

        // A title beyond the 64 KiB scan window falls back to the dir name.
        let late = dir.join("late.html");
        let pad = " ".repeat((TITLE_SCAN_LIMIT + 16) as usize);
        fs::write(&late, format!("{pad}<title>too late</title>")).expect("late");
        assert_eq!(html_page_title(&late), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
