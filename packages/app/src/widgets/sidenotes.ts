// 这层管：右栏（首版只有占位文案，**不伪造批注数据**）。面板开关只切 class。

import type { Host, NodeSpec } from "../dom.ts";
import type { ReaderState } from "../state.ts";
import { COPY } from "./copy.ts";
import type { Widget } from "./library.ts";

export const mountSidenotes = (host: Host, parent: string): Widget => {
  host.text(`${parent} #hr-notes-title`, COPY.sidenotes);
  host.text(`${parent} #hr-notes-body`, COPY.sidenotesEmpty);

  const update = (next: ReaderState): void => {
    // `sidenotes--open` 的写点只留在 `wiring.ts` 的 `syncView`（这里写会被它的全量同步恒覆盖）。
    host.attr(`${parent} #hr-notes`, "data-active-id", next.sidenoteId);
  };

  return { update };
};

// ---- 批注卡 ----

export interface AnnotationView {
  readonly id: string;
  readonly nodeId: string;
  readonly note: string;
  readonly status: "pending" | "resolved";
  readonly resolvedAt?: string;
  readonly resolutionNote?: string;
  /** 锚点失效（`anchor_lost` / 块已删）时卡片标灰并写明原因。 */
  readonly lost?: "anchor_lost" | "orphaned";
}

const lostLabel = (lost: AnnotationView["lost"]): string | undefined => {
  if (lost === "orphaned") return "锚点失效（原节点已删除）";
  if (lost === "anchor_lost") return "锚点失效（正文已改写）";
  return undefined;
};

/** 卡片里的三段（note / 失效原因 / 归档信息）：各段自己决定是否出现，不再"先判后取"导致二次默认值。 */
const noteChildrenOf = (annotation: AnnotationView): readonly NodeSpec[] => {
  const lost = lostLabel(annotation.lost);
  const resolved = annotation.resolvedAt;
  const resolution = annotation.resolutionNote;
  return [
    { tag: "p", attrs: { class: "annotation-note" }, text: annotation.note },
    ...(lost === undefined ? [] : [{ tag: "p", attrs: { class: "annotation-lost" }, text: lost }]),
    ...(resolved === undefined
      ? []
      : [
          {
            tag: "p",
            attrs: { class: "annotation-resolved" },
            text:
              resolution === undefined ? `已归档 ${resolved}` : `已归档 ${resolved}：${resolution}`,
          },
        ]),
  ];
};

/** 一张卡 → NodeSpec。`note` 走 `text`（`textContent` 语义），**永不** `html`。 */
const cardOf = (annotation: AnnotationView): NodeSpec => ({
  tag: "li",
  attrs: {
    "data-hr-annotation": annotation.id,
    "data-hr-node": annotation.nodeId,
    "data-hr-status": annotation.status,
    ...(annotation.lost === undefined ? {} : { "data-hr-lost": annotation.lost }),
  },
  children: noteChildrenOf(annotation),
});

interface SidenotesSpecs {
  readonly pending: readonly NodeSpec[];
  readonly resolved: readonly NodeSpec[];
}

/** 两条分组：顺序稳定 = 输入顺序，UI 不做重排（重排会跳卡）。 */
export const annotationSpecsOf = (view: readonly AnnotationView[]): SidenotesSpecs => {
  const pending = view.filter((item) => item.status === "pending").map(cardOf);
  const resolved = view.filter((item) => item.status === "resolved").map(cardOf);
  return { pending, resolved };
};
