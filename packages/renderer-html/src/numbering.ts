// 这层管：从 outline 派生章节号与目录项；不扫 DOM、不读文档。

import type { OutlineNode } from "@hreader/core";

export interface TocEntry {
  readonly id: string;
  readonly number: string;
  /** 标题层级 1–4，直接进 `toc__item--h<level>`（D6 契约）。 */
  readonly level: number;
  readonly text: string;
}

export interface Numbering {
  readonly entries: readonly TocEntry[];
  /** `data-hr-id` → 章节号；只有编号标题在内，容器节点查不到就不该有 `id="sec-…"`。 */
  readonly numberById: ReadonlyMap<string, string>;
  /** outline 里的 `section` 容器：正文要给它们加 `chapter` 类（§11.2：`header` 容器不产生 chapter）。 */
  readonly chapterIds: ReadonlySet<string>;
}

/** 只有 h1–h4 编号：h5/h6 已被 core 的 `OUTLINE_DEPTH_LIMIT` 挡在 outline 外，这里再兜一次。 */
const NUMBERED_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4"]);

interface Frame {
  readonly level: number;
  readonly number: string;
  /** 已发出的子节点数。父帧被同级的后继节点共享，故这个计数必须可变。 */
  childCount: number;
  readonly parent: Frame | undefined;
}

interface Collector {
  readonly entries: TocEntry[];
  readonly numberById: Map<string, string>;
  readonly chapterIds: Set<string>;
  /** 顶层计数单独放：顶层没有父帧可挂，`undefined` 父帧和"父帧层级不足"必须走同一条判断。 */
  topCount: number;
}

/** 父帧 = 最近一个层级更浅的已发节点；越级（h2→h4）就停在 h2，所以不会出现 `.0.` 空槽。 */
const ancestorOf = (level: number, cursor: Frame | undefined): Frame | undefined => {
  let ancestor = cursor;
  while (ancestor !== undefined && ancestor.level >= level) {
    ancestor = ancestor.parent;
  }
  return ancestor;
};

const nextCountOf = (parent: Frame | undefined, collector: Collector): number => {
  if (parent === undefined) {
    collector.topCount += 1;
    return collector.topCount;
  }
  parent.childCount += 1;
  return parent.childCount;
};

/** 返回本层最后一个帧：容器不重置游标，否则"上一个标题"会被容器遮住（h2 之后隔一层 section 的 h3 会挂错父级）。 */
const visit = (
  nodes: readonly OutlineNode[],
  cursor: Frame | undefined,
  collector: Collector,
): Frame | undefined => {
  let current = cursor;
  for (const node of nodes) {
    if (!NUMBERED_TAGS.has(node.tag)) {
      if (node.tag === "section") {
        collector.chapterIds.add(node.id);
      }
      current = visit(node.children, current, collector);
      continue;
    }
    const parent = ancestorOf(node.level, current);
    const count = nextCountOf(parent, collector);
    const number = parent === undefined ? String(count) : `${parent.number}.${String(count)}`;
    collector.entries.push({ id: node.id, number, level: node.level, text: node.text });
    collector.numberById.set(node.id, number);
    current = visit(node.children, { level: node.level, number, childCount: 0, parent }, collector);
  }
  return current;
};

export const numberingOf = (outline: readonly OutlineNode[]): Numbering => {
  const collector: Collector = {
    entries: [],
    numberById: new Map(),
    chapterIds: new Set(),
    topCount: 0,
  };
  visit(outline, undefined, collector);
  return {
    entries: collector.entries,
    numberById: collector.numberById,
    chapterIds: collector.chapterIds,
  };
};
