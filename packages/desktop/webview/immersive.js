// 沉浸模式：唯一真相源是 app 的 #hr-root[data-hr-immersive]（i / Esc / 底栏按钮
// 全汇到这一个属性）。壳层只做两件事：把属性镜像成 body[data-hrd-immersive]
// 让 workbench.css 藏掉桌面装饰（底栏是 !important 定位的，必须壳层自己藏），
// 以及给原生菜单一个与 app 按钮同一条路的出口。
const hrd = window.__hrd;

function immersiveOn() {
  const root = document.getElementById("hr-root");
  return Boolean(root && root.hasAttribute("data-hr-immersive"));
}

function applyImmersiveChrome(on) {
  if (on) document.body.setAttribute("data-hrd-immersive", "");
  else document.body.removeAttribute("data-hrd-immersive");
}

function toggleImmersive() {
  // 进出的所有路径（i、Esc、这个点击）都过 app 的同一个 intent，
  // 桌面不再另开一条状态机，两条路永远不会岔开。
  const btn = document.getElementById("hr-immersive-btn");
  if (btn) {
    btn.click();
    return;
  }
  if (!immersiveOn()) hrd.showToast("当前页面不支持沉浸模式", true);
}

function wireImmersiveSync() {
  const root = document.getElementById("hr-root");
  if (!root || hrd.state.immersiveWired) return;
  hrd.state.immersiveWired = true;
  const obs = new MutationObserver(() => applyImmersiveChrome(immersiveOn()));
  obs.observe(root, { attributes: true, attributeFilter: ["data-hr-immersive"] });
  applyImmersiveChrome(immersiveOn());
}

Object.assign(hrd, {
  applyImmersiveChrome,
  toggleImmersive,
  wireImmersiveSync,
});
