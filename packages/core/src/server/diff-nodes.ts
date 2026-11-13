// 这层管：两份文档模型的差异（新增/删除/文本或元素变化）→ 变更节点 id 列表；不解析 HTML、不碰 IO。

import type { DocumentModel } from "../model";

const flatten = (node: DocumentModel, into: Map<string, DocumentModel>): void => {
  into.set(node.id, node);
  for (const child of node.children) flatten(child, into);
};

/** 模型里没有属性：改属性（如主题色）不会出现在 `changedNodes` 里，见报告"已知限制"。 */
const differs = (before: DocumentModel, after: DocumentModel): boolean =>
  before.text !== after.text || before.tag !== after.tag || before.component !== after.component;

/** 顺序 = 新文档的先序（新增/变化），再把已删除的 id 按旧文档序接上。 */
export const diffNodes = (prev: DocumentModel, next: DocumentModel): readonly string[] => {
  const before = new Map<string, DocumentModel>();
  flatten(prev, before);
  const after = new Map<string, DocumentModel>();
  flatten(next, after);
  const changed: string[] = [];
  for (const [id, node] of after) {
    const previous = before.get(id);
    if (previous === undefined || differs(previous, node)) changed.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) changed.push(id);
  }
  return Object.freeze(changed);
};
