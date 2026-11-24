// 这层管：中栏（正文 + 控制条）。正文**只在 mount 注入一次**，之后按 `revision`
// 与 `blocks` 做块级 diff：内容变了写块、块没了删块；不在 `update` 里整篇重设。

import type { Host } from "../dom.ts";
import type { ReaderIntent, ReaderState } from "../state.ts";
import { COPY } from "./copy.ts";
import type { Widget } from "./library.ts";

interface CanvasInput {
  /** `GET /s/<docId>` 的 HTML（由 boot 取，canvas 不 fetch）。 */
  readonly html: string;
  readonly themes: readonly string[];
}

interface CanvasDeps {
  readonly host: Host;
  readonly parent: string;
  readonly state: ReaderState;
  readonly input: CanvasInput;
  readonly onIntent: (intent: ReaderIntent) => void;
}

const paintControls = (deps: CanvasDeps): void => {
  const { host, parent, input } = deps;
  host.text(`${parent} #hr-theme-label`, COPY.controlsTheme);
  host.text(`${parent} #hr-focus-label`, COPY.controlsFocus);
  host.children(
    `${parent} #hr-theme-select`,
    input.themes.map((theme) => ({ tag: "option", attrs: { value: theme }, text: theme })),
  );
};

/** 块级 diff：只写存在的块、删掉消失的块，并同步新增/改标签块；`revision` 是幂等键。 */
const diffBlocks = (host: Host, next: ReaderState, known: Set<string>): void => {
  const map = host.blocks(next.documentHtml);
  for (const id of known) if (!next.blocks.includes(id)) host.removeBlock(id);
  for (const id of next.blocks) {
    const markup = map.get(id);
    if (markup !== undefined) host.blockHtml(id, markup);
  }
  host.syncBlocks?.(next.documentHtml);
};

export const mountCanvas = (deps: CanvasDeps): Widget => {
  const { host, parent, input, onIntent, state } = deps;
  // 第一处 `innerHTML`：正文注入，一次；之后只走块级更新。
  host.html(`${parent} #hr-doc`, input.html);
  paintControls(deps);
  host.on(`${parent} #hr-theme-select`, "change", (target) => {
    if (target.value !== undefined && target.value !== "") {
      onIntent({ kind: "themeSelected", theme: target.value });
    }
  });
  host.on(`${parent} #hr-doc`, "click", (target) => {
    if (target.blockId !== undefined && target.blockId !== "") {
      onIntent({ kind: "scrollTo", id: target.blockId });
    }
  });

  let revision = state.revision;
  let known = new Set(state.blocks);
  let requested = state.themeRequested;

  const update = (next: ReaderState): void => {
    if (next.revision !== revision && next.documentHtml !== "") {
      diffBlocks(host, next, known);
      revision = next.revision;
      known = new Set(next.blocks);
    }
    if (next.themeRequested !== requested) {
      // 下拉显示"用户点的那个"；失败时 state 会把 themeRequested 回退成真实生效的值。
      host.attr(`${parent} #hr-theme-select`, "value", next.themeRequested);
      requested = next.themeRequested;
    }
    host.cls(`${parent} #hr-doc`, "canvas--focus", next.focus);
    for (const id of next.blocks) {
      host.cls(`${parent} [data-hr-id="${id}"]`, "doc__block--on", next.activeId === id);
    }
  };

  return { update };
};
