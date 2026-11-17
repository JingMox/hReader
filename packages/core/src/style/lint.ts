// 这层管：按词表在模型块上找禁用词（归一化、块内偏移、限流）；不解析 HTML、不改文档。

import { drainStack } from "../html/stack";
import type { DocumentModel } from "../model";
import type { LintHit, LintReport, VocabularySpec } from "./contracts";
import { foldOf, type Folded } from "./words";

/** 单块命中上限：与 M1.3/M1.4 的限流思路一致，禁止无限增长（AC6.4）。 */
export const LINT_HIT_LIMIT = 100;

const EXCERPT_RADIUS = 16;

interface Word {
  readonly word: string;
  readonly folded: string;
  readonly order: number;
}

interface Draft {
  readonly word: string;
  readonly order: number;
  readonly offset: number;
}

interface NodeHits {
  readonly hits: readonly LintHit[];
  readonly truncated: boolean;
}

const wordsOf = (forbidden: readonly string[]): readonly Word[] =>
  forbidden.map((word, order) => ({ word, folded: foldOf(word).text, order }));

const offsetsOf = (folded: Folded, word: Word): readonly Draft[] => {
  const drafts: Draft[] = [];
  if (word.folded.length === 0) return drafts;
  const needle = word.folded;
  for (let at = folded.text.indexOf(needle); at >= 0; at = folded.text.indexOf(needle, at + 1)) {
    const offset = folded.source[at];
    if (offset !== undefined) drafts.push({ word: word.word, order: word.order, offset });
  }
  return drafts;
};

/** 文档序：同偏移按词表顺序，同词多次出现逐次报告。 */
const compareDrafts = (left: Draft, right: Draft): number =>
  left.offset === right.offset ? left.order - right.order : left.offset - right.offset;

const excerptOf = (text: string, offset: number, width: number): string => {
  const start = Math.max(0, offset - EXCERPT_RADIUS);
  const end = Math.min(text.length, offset + width + EXCERPT_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

const hitsOfNode = (node: DocumentModel, words: readonly Word[]): NodeHits => {
  const folded = foldOf(node.text);
  const drafts = words.flatMap((word) => offsetsOf(folded, word)).sort(compareDrafts);
  const hits = drafts.slice(0, LINT_HIT_LIMIT).map((draft) => ({
    path: node.id,
    word: draft.word,
    excerpt: excerptOf(node.text, draft.offset, draft.word.length),
    offset: draft.offset,
  }));
  return { hits, truncated: drafts.length > LINT_HIT_LIMIT };
};

/** 迭代展开整棵模型树（文档序）：深文档不能用递归。 */
const flatten = (nodes: readonly DocumentModel[]): readonly DocumentModel[] => {
  const ordered: DocumentModel[] = [];
  const stack: DocumentModel[] = [...nodes].reverse();
  for (const node of drainStack(stack)) {
    ordered.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return ordered;
};

/** 命中按节点顺序、再按块内偏移排列；一个块超过上限即置 `truncated`。 */
export const lintByStyle = (
  nodes: readonly DocumentModel[],
  vocabulary: VocabularySpec,
): LintReport => {
  const words = wordsOf(vocabulary.forbidden);
  const hits: LintHit[] = [];
  let truncated = false;
  for (const node of flatten(nodes)) {
    const nodeHits = hitsOfNode(node, words);
    hits.push(...nodeHits.hits);
    truncated = truncated || nodeHits.truncated;
  }
  return { hits, truncated };
};
