// 左侧工作区文件树渲染、目录展开状态持久化与大纲过滤。
const hrd = window.__hrd;

function treeStorageKey() {
  return "hrd_tree_open_" + String(hrd.state.ctx.workspace || "default");
}

function loadExpandedDirs() {
  try {
    const raw = hrd.readStorage(window.localStorage, treeStorageKey());
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveExpandedDirs(set) {
  hrd.writeStorage(window.localStorage, treeStorageKey(), JSON.stringify([...set]));
}

function syncExpandedForActiveDoc() {
  hrd.state.expandedDirs = loadExpandedDirs();
  const active = hrd.currentDocId();
  if (!active || active === hrd.state.lastAutoExpandedDoc) return;
  hrd.state.lastAutoExpandedDoc = active;
  const parts = active.split("/");
  let changed = false;
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/");
    if (!hrd.state.expandedDirs.has(prefix)) {
      hrd.state.expandedDirs.add(prefix);
      changed = true;
    }
  }
  if (changed) saveExpandedDirs(hrd.state.expandedDirs);
}

function insertPathIntoTree(root, file) {
  const parts = String(file).split("/").filter(Boolean);
  let cursor = root;
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i];
    const path = parts.slice(0, i + 1).join("/");
    if (i === parts.length - 1) {
      cursor.push({ name, path, kind: "file", children: [] });
      continue;
    }
    let dir = cursor.find((n) => n.kind === "dir" && n.name === name);
    if (!dir) {
      dir = { name, path, kind: "dir", children: [] };
      cursor.push(dir);
    }
    cursor = dir.children;
  }
}

function workspaceTreeNodes() {
  const { ctx } = hrd.state;
  if (Array.isArray(ctx.tree) && ctx.tree.length > 0) return ctx.tree;
  const files = Array.isArray(ctx.files) ? ctx.files : [];
  const root = [];
  for (const file of files) insertPathIntoTree(root, file);
  return root;
}

// Expansion of a page's asset list is persisted in the same per-workspace set
// as directory expansion, under an "assets:" prefix so it can never collide
// with a real directory path.
function assetToggleKey(path) {
  return "assets:" + path;
}

// Same ordering as Rust `compare_tree_nodes`: directories first, then
// case-insensitive alpha, then case-sensitive tiebreak.
function compareTreeNodesJs(a, b) {
  const rank = (n) => (n.kind === "dir" ? 0 : 1);
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// "Show all files" unfolds the folded tree back into the raw directory
// structure: page-folders become real directories again, and a page's folded
// assets appear right after it as siblings (kept adjacent to their page).
function unfoldNodes(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.kind === "page-folder") {
      const merged = [...(node.children || []), ...(node.assets || [])].sort(compareTreeNodesJs);
      out.push({
        name: node.name,
        path: node.path,
        kind: "dir",
        children: unfoldNodes(merged),
      });
      continue;
    }
    out.push({ ...node, assets: [], children: unfoldNodes(node.children || []) });
    if (node.kind === "file" && Array.isArray(node.assets) && node.assets.length) {
      out.push(...unfoldNodes(node.assets));
    }
  }
  return out;
}

function nodeMatches(node, q) {
  return (
    node.name.toLowerCase().includes(q) ||
    node.path.toLowerCase().includes(q) ||
    (typeof node.title === "string" && node.title.toLowerCase().includes(q)) ||
    (typeof node.entry === "string" && node.entry.toLowerCase().includes(q))
  );
}

function filterAssetNodes(nodes, q) {
  const matched = [];
  for (const node of nodes) {
    if (node.kind === "dir") {
      const dirHits = node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q);
      const childHits = filterAssetNodes(node.children || [], dirHits ? "" : q);
      if (dirHits || childHits.length > 0) matched.push({ ...node, children: childHits });
    } else if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
      matched.push(node);
    }
  }
  return matched;
}

function filterTreeNodes(nodes, q, includeHidden) {
  if (!q) return nodes;
  const matched = [];
  for (const node of nodes) {
    if (node.hidden && !includeHidden) continue;
    if (node.kind === "dir") {
      const dirHits = node.name.toLowerCase().includes(q);
      const childHits = filterTreeNodes(node.children || [], dirHits ? "" : q, includeHidden);
      if (dirHits || childHits.length > 0) matched.push({ ...node, children: childHits });
    } else {
      const selfHits = nodeMatches(node, q);
      const assetHits = filterAssetNodes(node.assets || [], q);
      if (selfHits || assetHits.length > 0) {
        matched.push(assetHits.length > 0 ? { ...node, assets: assetHits } : node);
      }
    }
  }
  return matched;
}

function countTreeStats(nodes) {
  let docs = 0;
  let dirs = 0;
  let files = 0;
  for (const node of nodes) {
    if (node.kind === "dir") {
      dirs += 1;
      const sub = countTreeStats(node.children || []);
      docs += sub.docs;
      dirs += sub.dirs;
      files += sub.files;
    } else if (node.kind === "page-folder") {
      docs += 1;
    } else if (node.hidden) {
      files += 1;
    } else {
      docs += 1;
    }
  }
  return { docs, dirs, files };
}

function renderDirNodeHtml(node, active, forceExpand, showAll) {
  const { escapeHtmlText, ICONS } = hrd;
  const isOpen = forceExpand || hrd.state.expandedDirs.has(node.path);
  const childHtml = renderTreeRowsHtml(node.children || [], active, forceExpand, showAll);
  const chev = isOpen ? ICONS.treeChevDown : ICONS.treeChevRight;
  return `
    <div class="hrd-tree-group">
      <button type="button" class="hrd-tree-row dir" data-hrd-dir="${escapeHtmlText(node.path)}" title="${escapeHtmlText(node.path)}">
        <span class="hrd-tree-chev">${chev}</span>
        <span class="hrd-tree-label">${escapeHtmlText(node.name)}</span>
      </button>
      <div class="hrd-tree-children ${isOpen ? "" : "collapsed"}">${childHtml}</div>
    </div>
  `;
}

function fileRowHtml(node, active) {
  const { escapeHtmlText } = hrd;
  const displayName = node.name.replace(/\.html?$/i, "");
  const isActive = node.path === active;
  return `
    <button type="button" class="hrd-tree-row file ${isActive ? "active" : ""}" data-hrd-file="${escapeHtmlText(node.path)}" title="${escapeHtmlText(node.path)}">
      <span class="hrd-tree-label">${escapeHtmlText(displayName)}</span>
      <span class="hrd-tree-tag">HTML</span>
    </button>
  `;
}

// Non-document row (asset or show-all non-HTML file): click opens it with the
// system default application, never inside the reader.
function renderAssetRowHtml(node) {
  const { escapeHtmlText } = hrd;
  const dot = node.name.lastIndexOf(".");
  const ext = dot > 0 ? node.name.slice(dot + 1) : "";
  return `
    <button type="button" class="hrd-tree-row asset" data-hrd-asset="${escapeHtmlText(node.path)}" title="${escapeHtmlText(node.path)}">
      <span class="hrd-tree-label">${escapeHtmlText(node.name)}</span>
      <span class="hrd-tree-tag">${escapeHtmlText(ext || "FILE")}</span>
    </button>
  `;
}

function renderAssetDirHtml(node, active, forceExpand) {
  const { escapeHtmlText, ICONS } = hrd;
  const isOpen = forceExpand || hrd.state.expandedDirs.has(node.path);
  const childHtml = renderAssetTreeRowsHtml(node.children || [], active, forceExpand);
  const chev = isOpen ? ICONS.treeChevDown : ICONS.treeChevRight;
  return `
    <div class="hrd-tree-group">
      <button type="button" class="hrd-tree-row dir" data-hrd-dir="${escapeHtmlText(node.path)}" title="${escapeHtmlText(node.path)}">
        <span class="hrd-tree-chev">${chev}</span>
        <span class="hrd-tree-label">${escapeHtmlText(node.name)}</span>
      </button>
      <div class="hrd-tree-children ${isOpen ? "" : "collapsed"}">${childHtml}</div>
    </div>
  `;
}

// Asset listings show every entry (they ARE the resource view — hidden flags
// only gate the default tree view, not this one).
function renderAssetTreeRowsHtml(nodes, active, forceExpand) {
  return nodes
    .map((node) =>
      node.kind === "dir"
        ? renderAssetDirHtml(node, active, forceExpand)
        : renderAssetRowHtml(node),
    )
    .join("");
}

// A page row with an assets marker: the chevron button toggles the resource
// list; the row itself still opens the document.
function wrapWithAssets(rowHtml, node, active, forceExpand) {
  const { escapeHtmlText, ICONS } = hrd;
  const assets = Array.isArray(node.assets) ? node.assets : [];
  if (!assets.length) return rowHtml;
  const isOpen = forceExpand || hrd.state.expandedDirs.has(assetToggleKey(node.path));
  const chev = isOpen ? ICONS.treeChevDown : ICONS.treeChevRight;
  return `
    <div class="hrd-tree-group">
      <div class="hrd-tree-pagerow">
        <button type="button" class="hrd-tree-assetbtn" data-hrd-assets="${escapeHtmlText(node.path)}" title="${assets.length} 个资源文件">${chev}</button>
        ${rowHtml}
      </div>
      <div class="hrd-tree-children ${isOpen ? "" : "collapsed"}">${renderAssetTreeRowsHtml(assets, active, forceExpand)}</div>
    </div>
  `;
}

function renderPageFolderHtml(node, active, forceExpand) {
  const { escapeHtmlText, ICONS } = hrd;
  const label = typeof node.title === "string" && node.title ? node.title : node.name;
  const isActive = node.entry === active;
  const row = `
    <button type="button" class="hrd-tree-row file pagefolder ${isActive ? "active" : ""}" data-hrd-file="${escapeHtmlText(node.entry || node.path)}" title="${escapeHtmlText(node.path)}">
      <span class="hrd-tree-pageicon">${ICONS.vault}</span>
      <span class="hrd-tree-label">${escapeHtmlText(label)}</span>
      <span class="hrd-tree-tag">HTML</span>
    </button>
  `;
  return wrapWithAssets(row, node, active, forceExpand);
}

function renderNodeHtml(node, active, forceExpand, showAll) {
  if (node.hidden && !showAll) return "";
  if (node.kind === "dir") return renderDirNodeHtml(node, active, forceExpand, showAll);
  if (node.kind === "page-folder") return renderPageFolderHtml(node, active, forceExpand);
  if (node.hidden) return renderAssetRowHtml(node);
  return wrapWithAssets(fileRowHtml(node, active), node, active, forceExpand);
}

function renderTreeRowsHtml(nodes, active, forceExpand, showAll) {
  return nodes.map((node) => renderNodeHtml(node, active, forceExpand, showAll)).join("");
}

function renderFilesPanel(filterText) {
  const panel = document.getElementById("hr-files-panel");
  if (!panel) return;
  syncExpandedForActiveDoc();
  const active = hrd.currentDocId();
  const q = (filterText || "").trim().toLowerCase();
  const showAll = Boolean(hrd.state.prefs.showAllFiles);
  const rawTree = workspaceTreeNodes();
  const tree = showAll ? unfoldNodes(rawTree) : rawTree;
  const stats = countTreeStats(tree);
  const bodyHtml = renderTreeRowsHtml(
    filterTreeNodes(tree, q, showAll),
    active,
    Boolean(q),
    showAll,
  );
  const emptyMsg =
    '<div style="font-size:12px;color:var(--hr-muted);padding:10px 8px;">当前目录无匹配的 .html 笔记</div>';
  const filesPart = showAll ? ` · ${stats.files} 个其他文件` : "";
  panel.innerHTML = `
    <div class="hrd-tree-scroll">${bodyHtml || emptyMsg}</div>
    <div class="hrd-vault-foot">
      <span>${stats.docs} 篇笔记 · ${stats.dirs} 个文件夹${filesPart}</span>
      <button type="button" class="hrd-vault-new" id="hrd-vault-new-btn" title="新建笔记 (⌘N)">+ 新建笔记</button>
    </div>
  `;
}

function filterToc(filterText) {
  const toc = document.getElementById("hr-toc");
  if (!toc) return;
  const q = (filterText || "").trim().toLowerCase();
  for (const item of toc.children) {
    const txt = (item.textContent || "").toLowerCase();
    item.style.display = !q || txt.includes(q) ? "" : "none";
  }
}

hrd.state.expandedDirs = loadExpandedDirs();

Object.assign(hrd, {
  saveExpandedDirs,
  renderFilesPanel,
  filterToc,
});
