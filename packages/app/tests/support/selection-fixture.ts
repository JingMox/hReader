// 这层管：`main.ts` 划词路径的夹具——预置块/草稿/提交按钮 + 一个"真选区"。
// 单拆出来是为了让 `main.test.ts` 每条 `it` 守住 `max-lines-per-function: 40`。

import { vi } from "vitest";

import { fakeElement, type FakeElement } from "./fake-dom.ts";
import { flush, install, stubs } from "./main-stubs.ts";

export const ROOT = "#hr-root";

/** 绑定发生在启动时：块、草稿框、提交按钮都必须先于 `load()` 就位。 */
export const seedNotesSurface = (text = "正文一"): FakeElement => {
  const block = fakeElement("p");
  block.attrs.set("data-hr-id", "hr-a");
  block.textContent = text;
  stubs.doc.bySelector.set(`${ROOT} [data-hr-id="hr-a"]`, block);
  stubs.doc.bySelector.set(`${ROOT} #hr-note-draft`, fakeElement("textarea"));
  stubs.doc.bySelector.set(`${ROOT} #hr-note-submit`, fakeElement("button"));
  return block;
};

/** 假 `Range`：`toString()` 就是"块头到 offset 的前缀"（与真浏览器的度量同语义，裁定 #11）。 */
const rangeFactoryOf = (): (() => Record<string, unknown>) => {
  const range = {
    text: "",
    selectNodeContents(element: { readonly textContent: string | null }) {
      range.text = element.textContent ?? "";
    },
    setEnd(_node: unknown, offset: number) {
      range.text = range.text.slice(0, offset);
    },
    toString: () => range.text,
  };
  return () => ({ ...range });
};

/** `Shift+D` 的端到端夹具：真 keydown → 真 notes-wire → 服务端 `/diff`（`max-lines-per-function: 40`）。 */
export const toggleDiffWithShiftD = async (input: {
  readonly respond: (url: string) => Response;
  readonly load: () => Promise<void>;
}): Promise<FakeElement> => {
  install("doc.html", "http://x/", input.respond);
  seedNotesSurface();
  const chunks = fakeElement("div");
  stubs.doc.bySelector.set(`${ROOT} #hr-diff-chunks`, chunks);
  await input.load();

  // 首屏没有块；`doc.changed` 按模型重建块列表，`activeId` 才落到 `hr-a`，diff 路由才有目标。
  const source = stubs.sources[0];
  source?.onopen?.();
  source?.fire("doc.changed", JSON.stringify({ changedNodes: ["hr-a"] }), "7");
  await flush(5);
  stubs.keyHandlers[0]?.({ key: "d", shiftKey: true });
  await flush(5);
  return chunks;
};

/** 把“从启动到提交完成”整条链路挪出 `it`（`max-lines-per-function: 40`）。 */
export const submitNoteWithSelection = async (input: {
  readonly respond: (url: string) => Response;
  readonly load: () => Promise<void>;
  readonly draft?: string;
}): Promise<void> => {
  install("doc.html", "http://x/", input.respond);
  const block = seedNotesSurface();
  await input.load();

  // 选区落地后 `noteTarget` 才有值：写草稿并点提交，才会真的 POST 一条带 anchor 的批注。
  selectInBlock(block, 0, 3, "正文一");
  stubs.mouseups[0]?.();
  await flush();
  stubs.doc.fire(`${ROOT} #hr-note-draft`, "input", { value: input.draft ?? "我的批注" });
  stubs.doc.fire(`${ROOT} #hr-note-submit`, "click", {});
  await flush();
};

export const selectInBlock = (
  block: FakeElement,
  start: number,
  end: number,
  text: string,
): void => {
  const closest = () => block;
  stubs.selection = {
    rangeCount: 1,
    getRangeAt: () => ({
      startContainer: text,
      startOffset: start,
      endContainer: text,
      endOffset: end,
    }),
    anchorNode: { parentElement: { closest } },
    anchorOffset: start,
    focusNode: null,
    focusOffset: end,
    focusNodeParent: { closest },
  };
  vi.stubGlobal("document", { ...stubs.doc, createRange: rangeFactoryOf() });
};
