// 这层管：按 JSON 字节预算裁剪草稿树与批注（文档序尾部优先丢）；不改文本、不冻结。

import {
  OUTLINE_ANNOTATION_BYTE_LIMIT,
  OUTLINE_BYTE_LIMIT,
  OUTLINE_NODE_SCAN_LIMIT,
  OUTLINE_RESERVE_BYTES,
  type PendingAnnotation,
} from "./constants";
import { drainStack } from "../../html/stack";
import type { DraftNode } from "./walk";

export interface Budgeted {
  readonly nodes: readonly DraftNode[];
  readonly pending: readonly PendingAnnotation[];
  readonly droppedNodes: number;
  readonly droppedAnnotations: number;
}

interface Flat {
  readonly draft: DraftNode;
  readonly depth: number;
}

interface FitInput {
  readonly nodes: readonly DraftNode[];
  readonly pending: readonly PendingAnnotation[];
  readonly wordCount: number;
  /** 遍历阶段真实建出的节点数（可能远超扫描上限），丢弃数必须按它算。 */
  readonly builtNodes: number;
}

interface MeasureInput {
  readonly flat: readonly Flat[];
  readonly keep: number;
  readonly pending: readonly PendingAnnotation[];
  readonly wordCount: number;
}

const encoder = new TextEncoder();

const bytesOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/** 文档序先序平铺：父节点必在子节点之前，所以按前缀裁剪仍是合法树。 */
const flatten = (nodes: readonly DraftNode[], limit: number): readonly Flat[] => {
  const flat: Flat[] = [];
  const stack: Flat[] = [];
  for (const node of [...nodes].reverse()) {
    stack.push({ draft: node, depth: 1 });
  }
  for (const entry of drainStack(stack)) {
    if (flat.length >= limit) {
      break;
    }
    flat.push(entry);
    for (const child of [...entry.draft.children].reverse()) {
      stack.push({ draft: child, depth: entry.depth + 1 });
    }
  }
  return flat;
};

const rebuild = (flat: readonly Flat[], keep: number): readonly DraftNode[] => {
  const roots: DraftNode[] = [];
  const byDepth: DraftNode[] = [];
  for (const entry of flat.slice(0, keep)) {
    const { draft } = entry;
    const copy: DraftNode = {
      id: draft.id,
      tag: draft.tag,
      level: draft.level,
      text: draft.text,
      wordCount: draft.wordCount,
      children: [],
    };
    const parent = byDepth[entry.depth - 1];
    (parent === undefined ? roots : parent.children).push(copy);
    byDepth[entry.depth] = copy;
  }
  return roots;
};

const measure = (input: MeasureInput): number =>
  bytesOf({
    nodes: rebuild(input.flat, input.keep),
    pendingAnnotations: input.pending,
    wordCount: input.wordCount,
  });

const maxKeep = (input: MeasureInput, limit: number): number => {
  let low = 0;
  let high = input.flat.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure({ ...input, keep: middle }) <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

const maxPending = (input: FitInput, limit: number): number => {
  let low = 0;
  let high = input.pending.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const slice = input.pending.slice(0, middle);
    if (bytesOf({ pendingAnnotations: slice }) <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

export const fitBudget = (input: FitInput): Budgeted => {
  const limit = OUTLINE_BYTE_LIMIT - OUTLINE_RESERVE_BYTES;
  const flat = flatten(input.nodes, OUTLINE_NODE_SCAN_LIMIT);
  // 批注先拿固定份额，剩余预算归节点：两侧都不会把对方挤到零。
  const pendingCount = maxPending(input, OUTLINE_ANNOTATION_BYTE_LIMIT);
  const pending = input.pending.slice(0, pendingCount);
  const pendingBytes = bytesOf({ pendingAnnotations: pending });
  const keep = maxKeep(
    {
      flat,
      keep: flat.length,
      pending,
      wordCount: input.wordCount,
    },
    limit - pendingBytes,
  );
  return {
    nodes: rebuild(flat, keep),
    pending,
    droppedNodes: input.builtNodes - keep,
    droppedAnnotations: input.pending.length - pendingCount,
  };
};
