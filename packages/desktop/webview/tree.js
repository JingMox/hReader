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

function filterTreeNodes(nodes, q) {
  if (!q) return nodes;
  const matched = [];
  for (const node of nodes) {
    if (node.kind === "dir") {
      const dirHits = node.name.toLowerCase().includes(q);
      const childHits = filterTreeNodes(node.children || [], dirHits ? "" : q);
      if (dirHits || childHits.length > 0) matched.push({ ...node, children: childHits });
    } else if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
      matched.push(node);
    }
  }
  return matched;
}

function countTreeStats(nodes) {
  let docs = 0;
  let dirs = 0;
  for (const node of nodes) {
    if (node.kind === "dir") {
      dirs += 1;
      const sub = countTreeStats(node.children || []);
      docs += sub.docs;
      dirs += sub.dirs;
    } else {
      docs += 1;
    }
  }
  return { docs, dirs };
}

function renderDirNodeHtml(node, active, forceExpand) {
  const { escapeHtmlText, ICONS } = hrd;
  const isOpen = forceExpand || hrd.state.expandedDirs.has(node.path);
  const childHtml = renderTreeRowsHtml(node.children || [], active, forceExpand);
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

function renderFileNodeHtml(node, active) {
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

function renderTreeRowsHtml(nodes, active, forceExpand) {
  return nodes
    .map((node) =>
      node.kind === "dir"
        ? renderDirNodeHtml(node, active, forceExpand)
        : renderFileNodeHtml(node, active),
    )
    .join("");
}

function renderFilesPanel(filterText) {
  const panel = document.getElementById("hr-files-panel");
  if (!panel) return;
  syncExpandedForActiveDoc();
  const active = hrd.currentDocId();
  const q = (filterText || "").trim().toLowerCase();
  const rawTree = workspaceTreeNodes();
  const stats = countTreeStats(rawTree);
  const bodyHtml = renderTreeRowsHtml(filterTreeNodes(rawTree, q), active, Boolean(q));
  const emptyMsg =
    '<div style="font-size:12px;color:var(--hr-muted);padding:10px 8px;">当前目录无匹配的 .html 笔记</div>';
  panel.innerHTML = `
    <div class="hrd-tree-scroll">${bodyHtml || emptyMsg}</div>
    <div class="hrd-vault-foot">
      <span>${stats.docs} 篇笔记 · ${stats.dirs} 个文件夹</span>
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
