// 这层管：左栏（书库 + TOC 树）。只造 `NodeSpec`、调 `Host`，不碰 `document`；
// `update` 只在 **outline 换了引用**时重建列表，其余时候只切 `toc__item--on`（不重建子树）。

import type { Host, NodeSpec } from "../dom.ts";
import type { OutlineNode, ReaderIntent, ReaderState } from "../state.ts";
import { escapeAttr } from "../escape-attr.ts";
import { COPY } from "./copy.ts";

export interface Widget {
  readonly update: (state: ReaderState) => void;
}

const tocSpecs = (nodes: readonly OutlineNode[]): NodeSpec[] =>
  nodes.flatMap((node) => [
    {
      tag: "li",
      attrs: { class: `toc__item toc__item--h${String(node.level)}`, "data-toc-id": node.id },
      children: [{ tag: "span", text: node.text }],
    },
    ...(node.children === undefined ? [] : tocSpecs(node.children)),
  ]);

export const mountLibrary = (
  host: Host,
  parent: string,
  state: ReaderState,
  onIntent: (intent: ReaderIntent) => void,
): Widget => {
  host.text(`${parent} #hr-lib-title`, COPY.library);
  host.text(`${parent} #hr-toc-title`, COPY.outline);
  host.children(`${parent} #hr-toc`, tocSpecs(state.outline));
  host.on(`${parent} #hr-toc`, "click", (target) => {
    if (target.tocId === undefined) return;
    // 滚动的拥有者是左栏自己（它知道 TOC 与正文的选择器），intent 只负责状态：
    // 若把 scroll 再挂在 `boot.dispatchIntent` 上，同一个意图就有两个出口。
    host.scrollTo(`${parent} [data-hr-id="${escapeAttr(target.tocId)}"]`);
    onIntent({ kind: "scrollTo", id: target.tocId });
  });

  let outline: readonly OutlineNode[] | undefined = state.outline;
  const update = (next: ReaderState): void => {
    if (next.outline !== outline) {
      host.children(`${parent} #hr-toc`, tocSpecs(next.outline));
      outline = next.outline;
    }
    for (const id of next.blocks) {
      host.cls(
        `${parent} [data-toc-id="${escapeAttr(id)}"]`,
        "toc__item--on",
        next.activeId === id,
      );
    }
  };

  return { update };
};
