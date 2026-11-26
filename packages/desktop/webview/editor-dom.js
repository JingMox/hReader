// 块级元素判定、DOM 规范化克隆、行内 HTML 序列化与光标聚焦。
const hrd = window.__hrd;

const EDITABLE_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "blockquote"]);
const INLINE_TAGS = new Set([
  "strong",
  "b",
  "em",
  "i",
  "code",
  "a",
  "del",
  "s",
  "mark",
  "sup",
  "sub",
]);

function isSimpleEditableBlock(el) {
  if (!(el instanceof Element)) return false;
  if (!el.hasAttribute("data-hr-id") || el.hasAttribute("data-hr-component")) return false;
  if (el.closest("[data-hr-component]")) return false;
  return EDITABLE_TAGS.has(el.tagName.toLowerCase());
}

function supportsPlaintextEditable() {
  try {
    const probe = document.createElement("div");
    probe.setAttribute("contenteditable", "plaintext-only");
    return probe.contentEditable === "plaintext-only";
  } catch {
    return false;
  }
}

const EDITABLE_VALUE = supportsPlaintextEditable() ? "plaintext-only" : "true";

function contentBlocks() {
  const direct = [...document.querySelectorAll("#hr-doc article[data-hr-id] > [data-hr-id]")];
  return direct.length
    ? direct
    : [...document.querySelectorAll("#hr-doc [data-hr-id]:not(article)")];
}

function closestTopBlock(node) {
  if (!(node instanceof Element)) return null;
  const comp = node.closest("#hr-doc [data-hr-component][data-hr-id]");
  if (comp) return comp;
  return (
    node.closest("#hr-doc article[data-hr-id] > [data-hr-id]") ||
    node.closest("#hr-doc [data-hr-id]:not(article)")
  );
}

function activeBlockEl() {
  const active = document.querySelector("#hr-doc .doc__block--on[data-hr-id]:not(article)");
  if (active) return closestTopBlock(active) || active;
  if (document.activeElement instanceof Element) {
    const focused = closestTopBlock(document.activeElement);
    if (focused) return focused;
  }
  return contentBlocks()[0] || null;
}

function cleanBlockClone(el) {
  const clone = el.cloneNode(true);
  clone.removeAttribute("contenteditable");
  for (const nested of clone.querySelectorAll("[contenteditable]")) {
    nested.removeAttribute("contenteditable");
  }
  clone.classList.remove("doc__block--on", "hr-note-target", "hr-flash");
  if (clone.getAttribute("class") === "") clone.removeAttribute("class");
  return clone;
}

function serializeNodeInner(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return hrd.escapeHtmlText((node.nodeValue || "").replace(/\u00a0/g, " "));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "<br/>";
  let inner = "";
  for (const child of node.childNodes) inner += serializeNodeInner(child);
  if (!INLINE_TAGS.has(tag)) return inner;
  const href = tag === "a" ? node.getAttribute("href") : null;
  const attrs = href ? ' href="' + hrd.escapeHtmlText(href) + '"' : "";
  return "<" + tag + attrs + ">" + inner + "</" + tag + ">";
}

function serializeBlockHtml(el, tagOverride) {
  const tag = (tagOverride || el.tagName).toLowerCase();
  let inner = "";
  for (const child of el.childNodes) inner += serializeNodeInner(child);
  inner = inner.replace(/(?:<br\/>)+$/i, "");
  return "<" + tag + ">" + inner + "</" + tag + ">";
}

function enableBlockEditable(el) {
  if (!isSimpleEditableBlock(el)) return;
  if (el.getAttribute("contenteditable") !== EDITABLE_VALUE) {
    el.setAttribute("contenteditable", EDITABLE_VALUE);
  }
}

function syncAllEditables() {
  for (const block of contentBlocks()) {
    if (isSimpleEditableBlock(block)) enableBlockEditable(block);
  }
}

function placeCaretInBlock(el, atEnd) {
  enableBlockEditable(el);
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(!atEnd);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function focusBlockById(id, atEnd, attemptsLeft, expectedTag) {
  const tries = attemptsLeft === undefined ? 30 : attemptsLeft;
  const el = document.querySelector('#hr-doc [data-hr-id="' + CSS.escape(id) + '"]');
  const tagOk = !expectedTag || (el && el.tagName.toLowerCase() === expectedTag);
  if (el && isSimpleEditableBlock(el) && tagOk) {
    placeCaretInBlock(el, atEnd);
    return;
  }
  if (tries > 0) {
    setTimeout(() => focusBlockById(id, atEnd, tries - 1, expectedTag), 35);
  }
}

Object.assign(hrd, {
  isSimpleEditableBlock,
  contentBlocks,
  closestTopBlock,
  activeBlockEl,
  cleanBlockClone,
  serializeBlockHtml,
  enableBlockEditable,
  syncAllEditables,
  focusBlockById,
});
