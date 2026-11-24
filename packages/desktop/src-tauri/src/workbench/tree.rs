//! 工作区目录树扫描：递归收集目录与 `.html`/`.htm` 文档，跳过隐藏目录与构建产物。

use std::cmp::Ordering;
use std::fs;
use std::path::Path;

use serde::Serialize;

const MAX_TREE_DEPTH: usize = 8;
const MAX_TREE_NODES: usize = 2000;

/// 左侧文件树节点类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TreeEntryKind {
    Dir,
    File,
}

/// 左侧工作区目录树节点（支持任意层级嵌套文件夹与 HTML 笔记）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub kind: TreeEntryKind,
    pub children: Vec<TreeNode>,
}

fn should_skip_entry_name(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist")
}

/// 递归扫描工作区，返回按「文件夹优先 + 字母序」排列的嵌套目录树（仅包含目录与 `.html`/`.htm` 文件）。
pub fn scan_workspace_tree(workspace: &Path) -> Vec<TreeNode> {
    let mut remaining = MAX_TREE_NODES;
    scan_dir_nodes(workspace, "", 0, &mut remaining)
}

fn scan_dir_nodes(dir: &Path, prefix: &str, depth: usize, remaining: &mut usize) -> Vec<TreeNode> {
    if depth >= MAX_TREE_DEPTH || *remaining == 0 {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut nodes = Vec::new();
    for entry in entries.flatten() {
        if *remaining == 0 {
            break;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if should_skip_entry_name(&name) {
            continue;
        }
        let path = entry.path();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            *remaining = remaining.saturating_sub(1);
            let children = scan_dir_nodes(&path, &rel, depth + 1, remaining);
            nodes.push(TreeNode {
                name,
                path: rel,
                kind: TreeEntryKind::Dir,
                children,
            });
        } else if path.is_file() && is_html_file(&path) {
            *remaining = remaining.saturating_sub(1);
            nodes.push(TreeNode {
                name,
                path: rel,
                kind: TreeEntryKind::File,
                children: Vec::new(),
            });
        }
    }
    nodes.sort_by(compare_tree_nodes);
    nodes
}

fn compare_tree_nodes(a: &TreeNode, b: &TreeNode) -> Ordering {
    let rank = |k: TreeEntryKind| match k {
        TreeEntryKind::Dir => 0u8,
        TreeEntryKind::File => 1u8,
    };
    rank(a.kind)
        .cmp(&rank(b.kind))
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

fn collect_files_from_tree(nodes: &[TreeNode], out: &mut Vec<String>) {
    for node in nodes {
        match node.kind {
            TreeEntryKind::Dir => collect_files_from_tree(&node.children, out),
            TreeEntryKind::File => out.push(node.path.clone()),
        }
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

    #[test]
    fn scan_workspace_tree_builds_nested_sorted_tree_and_skips_hidden() {
        let dir = temp_ws("tree");
        fs::create_dir_all(dir.join("system/paper/deep")).expect("deep dir");
        fs::create_dir_all(dir.join("empty_folder")).expect("empty dir");
        fs::create_dir_all(dir.join(".hidden_dir")).expect("hidden dir");
        fs::create_dir_all(dir.join("node_modules/pkg")).expect("node_modules dir");
        fs::write(dir.join("root.html"), "").expect("root html");
        fs::write(dir.join("readme.txt"), "").expect("txt ignored");
        fs::write(dir.join("system/paper/deep/note.html"), "").expect("deep note");
        fs::write(dir.join("node_modules/pkg/skip.html"), "").expect("skip nm");

        let tree = scan_workspace_tree(&dir);
        let names: Vec<&str> = tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["empty_folder", "system", "root.html"]);
        assert_eq!(tree[0].kind, TreeEntryKind::Dir);
        assert_eq!(tree[1].children[0].name, "paper");
        assert_eq!(tree[1].children[0].children[0].name, "deep");
        assert_eq!(
            tree[1].children[0].children[0].children[0].path,
            "system/paper/deep/note.html"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
