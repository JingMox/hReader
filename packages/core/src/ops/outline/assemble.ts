// 这层管：把 walk/meta/预算的结果装配成冻结的 `Outline`；不做 IO、不改入参、不做遍历。

import { type Diagnostic, type ParsedHtml } from "../../html/constants";
import { readMeta } from "../../meta";
import { pendingAnnotations } from "./annotations";
import { type Budgeted, fitBudget } from "./budget";
import type { Outline, OutlineNode } from "./constants";
import { fitDiagnostics } from "./diagnostics";
import { type DraftNode, walkArticle } from "./walk";

const toOutlineNode = (draft: DraftNode): OutlineNode =>
  Object.freeze({
    id: draft.id,
    tag: draft.tag,
    level: draft.level,
    text: draft.text,
    wordCount: draft.wordCount,
    children: Object.freeze(draft.children.map(toOutlineNode)),
  });

const freezeNodes = (drafts: readonly DraftNode[]): readonly OutlineNode[] =>
  Object.freeze(drafts.map(toOutlineNode));

/** 截断原因按"结构/文本、预算丢节点、预算丢批注"三段报，数字全是实测值。 */
const truncationParts = (
  walked: { readonly truncatedText: number; readonly truncatedDepth: number },
  budgeted: Budgeted,
): readonly string[] => {
  const parts: string[] = [];
  const structural = walked.truncatedText + walked.truncatedDepth;
  if (structural > 0) {
    parts.push(`命中结构/文本上限 ${String(structural)} 处`);
  }
  if (budgeted.droppedNodes > 0) {
    parts.push(`按字节预算丢弃节点 ${String(budgeted.droppedNodes)} 个`);
  }
  if (budgeted.droppedAnnotations > 0) {
    parts.push(`按字节预算丢弃批注 ${String(budgeted.droppedAnnotations)} 条`);
  }
  return parts;
};

export const buildOutline = (parsed: ParsedHtml): Outline => {
  const walked = walkArticle(parsed);
  const meta = readMeta(parsed);
  const annotations = pendingAnnotations(meta.annotations, parsed.root);
  const base: readonly Diagnostic[] = [
    ...parsed.diagnostics,
    ...meta.diagnostics,
    ...annotations.diagnostics,
    ...walked.diagnostics,
  ];
  const budgeted = fitBudget({
    nodes: walked.nodes,
    pending: annotations.pending,
    wordCount: walked.wordCount,
    builtNodes: walked.builtNodes,
  });
  const diagnostics = fitDiagnostics(base, truncationParts(walked, budgeted));
  return Object.freeze({
    nodes: freezeNodes(budgeted.nodes),
    pendingAnnotations: Object.freeze([...budgeted.pending]),
    wordCount: walked.wordCount,
    diagnostics: Object.freeze([...diagnostics]),
  });
};
