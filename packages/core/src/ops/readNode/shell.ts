// 这层管：判定/剔除页面外壳（html/body/head、hr-meta、hr-theme、script/style/template）；不改入参。

import type { HtmlElementNode, HtmlNode } from "../../html/constants";
import { drainStack } from "../../html/stack";
import { BLOCKED_CONTENT_TAGS, META_ANCHOR_ID, SHELL_TAGS, THEME_ANCHOR_ID } from "./constants";

interface Stripped {
  readonly root: HtmlElementNode;
  /** 被剔除的外壳内容个数（`script`/`style`/`template`，含两个锚点）。 */
  readonly stripped: number;
}

/** 目标本身就是外壳：`html`/`body`/`head` 与任何 `script`/`style`/`template`。 */
export const isForbiddenTarget = (node: HtmlElementNode): boolean =>
  SHELL_TAGS.has(node.tag) || BLOCKED_CONTENT_TAGS.has(node.tag);

/** 锚点 id 是保留字：`#hr-meta`/`#hr-theme` 指的就是外壳锚点，与 `data-hr-id` 空间无关。 */
export const isReservedAnchorId = (id: string): boolean =>
  id === META_ANCHOR_ID || id === THEME_ANCHOR_ID;

/** 目标本身禁读只挡了入口：子树里的可执行/模板内容必须整块剔除才算不泄漏。 */
const isShellContent = (node: HtmlElementNode): boolean => BLOCKED_CONTENT_TAGS.has(node.tag);

interface Task {
  readonly node: HtmlNode;
  /** 该节点要落进的兄弟数组（父元素的 `children`）。 */
  readonly sink: HtmlNode[];
}

/**
 * 迭代复制：深文档递归会炸栈。只有外壳锚点被丢掉，其余节点（含文本/注释）原样复用。
 * 新建元素时 `children` 与落点数组是同一个引用，所以不需要“回填父节点”的第二趟。
 */
export const stripShell = (node: HtmlElementNode): Stripped => {
  const children: HtmlNode[] = [];
  const root: HtmlElementNode = { kind: "element", tag: node.tag, attrs: node.attrs, children };
  const tasks: Task[] = [];
  let stripped = 0;
  const load = (source: readonly HtmlNode[], sink: HtmlNode[]): void => {
    for (const child of [...source].reverse()) {
      tasks.push({ node: child, sink });
    }
  };
  load(node.children, children);
  for (const task of drainStack(tasks)) {
    if (task.node.kind !== "element") {
      task.sink.push(task.node);
      continue;
    }
    if (isShellContent(task.node)) {
      stripped += 1;
      continue;
    }
    const sink: HtmlNode[] = [];
    task.sink.push({ kind: "element", tag: task.node.tag, attrs: task.node.attrs, children: sink });
    load(task.node.children, sink);
  }
  return { root, stripped };
};
