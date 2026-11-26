// `#hr-note-btn` 在模板里写死 `hidden`（audit：`static/index.html:30`），
// 必须由状态把它摘掉/挂回。直接 `fire("click")` 只能证明"处理器在"，
// 证明不了"用户在浏览器里点得到"——这里断的是属性本身。

import { describe, expect, it } from "vitest";

import { hiddenOf } from "./support/hidden.ts";
import { bootedWith, cancelOf, SELECTION, selectOf } from "./support/notes-harness.ts";

describe("浮动按钮 · 真实可见性", () => {
  it("should start hidden in the template and become visible after a selection", () => {
    const h = bootedWith();
    expect(hiddenOf(h.fake, "hr-note-btn")).toBe(true);

    selectOf(h, SELECTION);

    expect(hiddenOf(h.fake, "hr-note-btn")).toBe(false);
    h.booted.destroy();
  });

  it("should hide again when the selection is cancelled", () => {
    const h = bootedWith();
    selectOf(h, SELECTION);
    expect(hiddenOf(h.fake, "hr-note-btn")).toBe(false);

    cancelOf(h);

    expect(hiddenOf(h.fake, "hr-note-btn")).toBe(true);
    h.booted.destroy();
  });
});
