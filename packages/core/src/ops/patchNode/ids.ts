// 这层管：`data-hr-id` 的收集与剥离；片段里的 ID 一律不可信，必须先整棵剥掉再重新注入。

import type { HtmlAttribute, HtmlElementNode, HtmlNode } from "../../html/constants";
import { HR_ID_ATTRIBUTE } from "../../html/constants";
import { drainStack } from "../../html/stack";
import { walkElements } from "./walk";

const isHrId = (attribute: HtmlAttribute): boolean => attribute[0] === HR_ID_ATTRIBUTE;

/** 文档里已占用的 ID（含非法值）：给片段注入时当保留集，避免撞车产生重复 ID。 */
export const collectHrIds = (root: HtmlNode): readonly string[] => {
  const ids: string[] = [];
  walkElements(root, (node) => {
    for (const attribute of node.attrs) {
      if (isHrId(attribute)) ids.push(attribute[1]);
    }
  });
  return ids;
};

interface Sink {
  readonly push: (node: HtmlNode) => void;
}

interface EnterTask {
  readonly kind: "enter";
  readonly node: HtmlNode;
  readonly sink: Sink;
}

interface ExitTask {
  readonly kind: "exit";
  readonly node: HtmlElementNode;
  readonly attrs: readonly HtmlAttribute[];
  readonly children: readonly HtmlNode[];
  readonly sink: Sink;
}

type StripTask = EnterTask | ExitTask;

const openElement = (task: EnterTask, element: HtmlElementNode, stack: StripTask[]): void => {
  const children: HtmlNode[] = [];
  const sink: Sink = { push: (child) => children.push(child) };
  stack.push({
    kind: "exit",
    node: element,
    attrs: element.attrs.filter((attribute) => !isHrId(attribute)),
    children,
    sink: task.sink,
  });
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    const child = element.children[index];
    if (child !== undefined) stack.push({ kind: "enter", node: child, sink });
  }
};

/** 重建而非就地改：调用的 `parsed.root` 可能还被别处引用，patch 不许改入参。 */
export const stripHrIds = (root: HtmlNode): HtmlNode => {
  let result: HtmlNode = root;
  const stack: StripTask[] = [
    {
      kind: "enter",
      node: root,
      sink: {
        push: (node) => {
          result = node;
        },
      },
    },
  ];
  for (const task of drainStack(stack)) {
    if (task.kind === "exit") {
      task.sink.push({
        kind: "element",
        tag: task.node.tag,
        attrs: task.attrs,
        children: task.children,
      });
      continue;
    }
    if (task.node.kind === "element") {
      openElement(task, task.node, stack);
      continue;
    }
    task.sink.push(task.node);
  }
  return result;
};
