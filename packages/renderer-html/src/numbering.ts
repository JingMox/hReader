// Derives chapter numbers and TOC entries from the outline; does not scan the DOM or read documents.

import type { OutlineNode } from "@hreader/core";

export interface TocEntry {
  readonly id: string;
  readonly number: string;
  /** Heading level 1–4; feeds the `toc__item--h<level>` class directly. */
  readonly level: number;
  readonly text: string;
}

export interface Numbering {
  readonly entries: readonly TocEntry[];
  /** `data-hr-id` → chapter number; only numbered headings appear, so a missing container node must not get an `id="sec-…"`. */
  readonly numberById: ReadonlyMap<string, string>;
  /** `section` containers from the outline: the body marks them with the `chapter` class (`header` containers produce no chapter). */
  readonly chapterIds: ReadonlySet<string>;
}

/** Only h1–h4 get numbers: h5/h6 are already kept out of the outline by core's `OUTLINE_DEPTH_LIMIT`; this is a second net. */
const NUMBERED_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4"]);

interface Frame {
  readonly level: number;
  readonly number: string;
  /** Number of emitted children. A parent frame is shared by same-level successors, so this count must be mutable. */
  childCount: number;
  readonly parent: Frame | undefined;
}

interface Collector {
  readonly entries: TocEntry[];
  readonly numberById: Map<string, string>;
  readonly chapterIds: Set<string>;
  /** Top-level count lives apart: top-level nodes have no parent frame, and an `undefined` parent must share the "no shallow-enough parent" check. */
  topCount: number;
}

/** Parent frame = the nearest emitted node of a shallower level; a level skip (h2→h4) stops at the h2, so no `.0.` gap appears. */
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

/** Returns the last frame at this level: containers must not reset the cursor, or a container hides the previous heading (an h3 one section after an h2 would attach to the wrong parent). */
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
