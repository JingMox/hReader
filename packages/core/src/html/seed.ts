// 这层管：复算"某节点在文档里被注入时拿到的 (父摘要, 同标签兄弟序号)"；不分配 ID、不碰 IO。

import type { HtmlNode } from "./constants";
import { HASH_SEED, mixHex } from "./hash";
import { childSlots } from "./slots";
import { drainStack } from "./stack";

/**
 * 片段根元素在**文档里原本的位置**：`replace` 用它让"未改动的子树复算出原来的 ID"（批注锚点不丢）。
 * 两个字段就是注入器算 `digest` 所需的输入，因此拿目标节点的这两个值注入片段，
 * 每层子节点的 `digest` 链与 normalize 时逐位相同，内容没变的那层就能拿回原 ID。
 */
export interface InjectSeed {
  /** 父节点的路径摘要。 */
  readonly parentDigest: number;
  /** 在父 `children` 里的同标签兄弟序号。 */
  readonly siblingIndex: number;
}

/** 文档根的种子：没有父节点、也不是任何人的兄弟。normalize 的根就是它。 */
export const ROOT_SEED: InjectSeed = { parentDigest: HASH_SEED, siblingIndex: -1 };

interface SeedTask extends InjectSeed {
  readonly node: HtmlNode;
}

/** 子节点的摘要输入：元素续算自己的摘要，document 不参与摘要（与注入器的 `enterNode` 同口径）。 */
const childDigestOf = (task: SeedTask): number =>
  task.node.kind === "element"
    ? mixHex(`${task.node.tag}#${String(task.siblingIndex)}`, task.parentDigest)
    : task.parentDigest;

const pushSeedTasks = (task: SeedTask, stack: SeedTask[]): void => {
  const children =
    task.node.kind === "element" || task.node.kind === "document" ? task.node.children : [];
  const slots = childSlots(children);
  const parentDigest = childDigestOf(task);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    const slot = slots[index];
    if (child !== undefined && slot !== undefined) {
      stack.push({ node: child, parentDigest, siblingIndex: slot.siblingIndex });
    }
  }
};

/**
 * 复算某节点如果在文档里被注入时拿到的种子；找不到返回 `undefined`。
 * 走与 `injectNodeIds` 同一条先序 + 同一张 `childSlots` 表，否则 `replace` 算出的 ID 会与 normalize 错开。
 * 调用面（`ops/patchNode/apply.ts` 的 `replaceScopeOf`）传的 `target` 就是刚从 `root` 里 locate 到的节点，
 * 遍历必命中；`undefined` 只用于与 `replace` 根目标的 `seed: undefined` 合并类型，是跑不到的口子。
 */
export const injectSeedOf = (root: HtmlNode, target: HtmlNode): InjectSeed | undefined => {
  const stack: SeedTask[] = [{ node: root, ...ROOT_SEED }];
  for (const task of drainStack(stack)) {
    if (task.node === target) {
      return { parentDigest: task.parentDigest, siblingIndex: task.siblingIndex };
    }
    pushSeedTasks(task, stack);
    // 防御兜底（只靠变异证明跑不到）：调用面传的 `target` 就是刚从同一棵 `root` 里 locate 到的节点，
    // 先序遍历必命中；`undefined` 仅用于与“根目标无种子”合并类型（`ops/patchNode/apply.ts` 的 `replaceScopeOf`）。
    /* v8 ignore start */
  }
  return undefined;
};
/* v8 ignore stop */
