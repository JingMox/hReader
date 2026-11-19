// 这层管：把 `children` 映射成"同标签兄弟序号 + 原始下标"两张索引；不分配 ID、不判内容模型。

import type { HtmlNode } from "./constants";

interface ChildSlot {
  /** 同标签兄弟序号：只喂 ID 种子，换写法会让既有 `data-hr-id` 全部变。 */
  readonly siblingIndex: number;
  /** 父 `children` 里的原始下标：只喂诊断路径，与解析层同一口径。 */
  readonly childIndex: number;
}

/**
 * 元素按**同标签**计数（`<p>a<div>b</div><p>c` 的两个 `<p>` 是 0 和 1），非元素记 -1。
 * 注入器与 `injectSeedOf` 共用这一张表：两边口径一变，`replace` 复算出的 ID 就会与 normalize 错开。
 */
export const childSlots = (children: readonly HtmlNode[]): readonly ChildSlot[] => {
  const seen = new Map<string, number>();
  return children.map((child, childIndex) => {
    if (child.kind !== "element") {
      return { siblingIndex: -1, childIndex };
    }
    const index = seen.get(child.tag) ?? 0;
    seen.set(child.tag, index + 1);
    return { siblingIndex: index, childIndex };
  });
};
