// 浮动菜单、块级左侧操作条（Gutter）与通用模态框容器。
const hrd = window.__hrd;

function closeFloatMenu() {
  const menu = document.getElementById("hrd-float-menu");
  if (menu) menu.classList.remove("open");
  hrd.state.openMenuKind = null;
}

function openFloatMenu(kind, anchorEl, buildHtml, onPick) {
  let menu = document.getElementById("hrd-float-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "hrd-float-menu";
    document.body.appendChild(menu);
  }
  if (hrd.state.openMenuKind === kind && menu.classList.contains("open")) {
    closeFloatMenu();
    return;
  }
  hrd.state.openMenuKind = kind;
  menu.innerHTML = buildHtml;
  menu.classList.add("open");
  const rect = anchorEl.getBoundingClientRect();
  const mw = Math.max(menu.offsetWidth, 196);
  const mh = menu.offsetHeight || 220;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - mw - 10);
  const top =
    rect.top > mh + 16 && rect.bottom > window.innerHeight - 160
      ? rect.top - mh - 6
      : Math.min(rect.bottom + 6, window.innerHeight - mh - 8);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  menu.onclick = (e) => {
    e.stopPropagation();
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    closeFloatMenu();
    onPick(act);
  };
}

function hideGutter() {
  const g = document.getElementById("hrd-block-gutter");
  if (g) g.classList.remove("visible");
}

function positionGutter(el) {
  const canvas = document.getElementById("hr-canvas");
  const gutter = document.getElementById("hrd-block-gutter");
  if (!canvas || !gutter || !el || hrd.state.sourceMode) return;
  hrd.state.gutterBlock = el;
  const cRect = canvas.getBoundingClientRect();
  const bRect = el.getBoundingClientRect();
  gutter.style.left = Math.max(4, bRect.left - cRect.left - 50) + "px";
  gutter.style.top = bRect.top - cRect.top + canvas.scrollTop + 3 + "px";
  gutter.classList.add("visible");
}

function openGutterAddMenu(anchor, target) {
  const { escapeHtmlText, COMPONENTS } = hrd;
  const compButtons = COMPONENTS.map(
    (c) =>
      `<button type="button" class="hrd-dd-item" data-act="c:${escapeHtmlText(c.id)}"><span>${escapeHtmlText(c.label)}</span><span style="opacity:.6;font-size:11px;">${escapeHtmlText(c.tag)}</span></button>`,
  ).join("");
  openFloatMenu(
    "gutter-add",
    anchor,
    `
      <div class="hrd-menu-hdr">在当前块后插入</div>
      <button type="button" class="hrd-dd-item" data-act="para"><span>正文段落 P</span><span>Enter</span></button>
      ${compButtons}
    `,
    (act) => {
      if (act === "para") {
        hrd.insertAfterBlock(target, "<p></p>", null, true);
        return;
      }
      if (act && act.startsWith("c:")) {
        const comp = COMPONENTS.find((c) => c.id === act.slice(2));
        if (comp) hrd.insertAfterBlock(target, comp.html, comp.label, false);
      }
    },
  );
}

function openGutterMoreMenu(anchor, target) {
  openFloatMenu(
    "gutter-more",
    anchor,
    `
      <div class="hrd-menu-hdr">块格式与操作</div>
      <button type="button" class="hrd-dd-item" data-act="tag:p"><span>转为正文 P</span></button>
      <button type="button" class="hrd-dd-item" data-act="tag:h1"><span>转为一级标题 H1</span><span>#</span></button>
      <button type="button" class="hrd-dd-item" data-act="tag:h2"><span>转为二级标题 H2</span><span>##</span></button>
      <button type="button" class="hrd-dd-item" data-act="tag:h3"><span>转为三级标题 H3</span><span>###</span></button>
      <button type="button" class="hrd-dd-item" data-act="tag:blockquote"><span>转为引用块</span><span>&gt;</span></button>
      <div class="hrd-dd-sep"></div>
      <button type="button" class="hrd-dd-item" data-act="html"><span>编辑节点 HTML…</span><span>⌘E</span></button>
      <button type="button" class="hrd-dd-item" data-act="note"><span>为整段添加批注</span><span>c</span></button>
      <button type="button" class="hrd-dd-item" data-act="del" style="color:#a3341a;"><span>删除此块</span></button>
    `,
    (act) => {
      if (!act) return;
      if (act.startsWith("tag:")) hrd.convertBlockTag(target, act.slice(4));
      else if (act === "html") hrd.openBlockHtmlModal(target);
      else if (act === "note") hrd.triggerWholeBlockNote(target);
      else if (act === "del") hrd.deleteBlock(target);
    },
  );
}

function ensureGutter() {
  const canvas = document.getElementById("hr-canvas");
  if (!canvas || document.getElementById("hrd-block-gutter")) return;
  const gutter = document.createElement("div");
  gutter.id = "hrd-block-gutter";
  gutter.innerHTML = `
    <button type="button" class="hrd-gut-btn" id="hrd-gut-add" title="在下方插入段落或组件">+</button>
    <button type="button" class="hrd-gut-btn" id="hrd-gut-more" title="段落转换、编辑源码或删除">⋮</button>
  `;
  canvas.appendChild(gutter);
  gutter.addEventListener("mouseenter", () => {
    if (hrd.state.gutterTimer) clearTimeout(hrd.state.gutterTimer);
  });
  gutter.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = hrd.state.gutterBlock || hrd.activeBlockEl();
    if (!target) return;
    const addBtn = e.target.closest("#hrd-gut-add");
    if (addBtn) openGutterAddMenu(addBtn, target);
    const moreBtn = e.target.closest("#hrd-gut-more");
    if (moreBtn) openGutterMoreMenu(moreBtn, target);
  });
}

function ensureModal(id, title, bodyHtml, footerHtml) {
  hideGutter();
  closeFloatMenu();
  let backdrop = document.getElementById("hrd-modal-backdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "hrd-modal-backdrop";
    backdrop.className = "hrd-modal-backdrop";
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.classList.remove("open");
    });
    backdrop.addEventListener("mouseup", (e) => e.stopPropagation());
    document.body.appendChild(backdrop);
  }
  backdrop.innerHTML = `
    <div class="hrd-modal" data-hrd-modal="${id}">
      <h3>${hrd.escapeHtmlText(title)}</h3>
      <div>${bodyHtml}</div>
      <div class="hrd-modal-actions">${footerHtml}</div>
    </div>
  `;
  backdrop.classList.add("open");
  return backdrop;
}

function closeModal() {
  const backdrop = document.getElementById("hrd-modal-backdrop");
  if (backdrop) backdrop.classList.remove("open");
}

Object.assign(hrd, {
  closeFloatMenu,
  openFloatMenu,
  hideGutter,
  positionGutter,
  ensureGutter,
  ensureModal,
  closeModal,
});
