// 这层管：给 `<article>` 内的块级元素分配稳定 `data-hr-id`；不解析、不序列化、不改入参。

import {
  ARTICLE_TAG,
  BLOCK_TAGS,
  COMPONENT_ATTRIBUTE,
  type Diagnostic,
  HR_ID_ATTRIBUTE,
  HR_ID_PATTERN,
  type HtmlAttribute,
  type HtmlElementNode,
  type HtmlNode,
  type ParsedHtml,
} from "./constants";
import { HASH_SEED, mixHex, stableHex8 } from "./hash";
import { joinPath, pathSegment } from "./path";
import { drainStack } from "./stack";
import { textSampleOf } from "./text";

export interface InjectedNodeIds {
  readonly parsed: ParsedHtml;
  readonly injected: readonly string[];
}

const TEXT_SAMPLE_LENGTH = 64;

const attributeValue = (attrs: readonly HtmlAttribute[], name: string): string | undefined => {
  for (const [attributeName, value] of attrs) {
    if (attributeName === name) {
      return value;
    }
  }
  return undefined;
};

const isBlockElement = (node: HtmlElementNode): boolean =>
  BLOCK_TAGS.has(node.tag) ||
  (node.tag === "div" && attributeValue(node.attrs, COMPONENT_ATTRIBUTE) !== undefined);

/** 注入目标：最外层 `<article>` 自身，以及 article 内的块级元素（嵌套 article 不另注入）。 */
const isInjectionTarget = (node: HtmlElementNode, insideArticle: boolean): boolean =>
  node.tag === ARTICLE_TAG ? !insideArticle : insideArticle && isBlockElement(node);

/** 最多收集 64 个字符即停，避免整棵子树拼接；只按这个前缀算 ID，不看子树第 65 个字符之后。 */
const textSample = (node: HtmlNode): string =>
  textSampleOf(node, TEXT_SAMPLE_LENGTH).replace(/\s+/gu, " ").trim();

const collectValidIds = (root: HtmlNode): Set<string> => {
  const ids = new Set<string>();
  const stack: HtmlNode[] = [root];
  for (const current of drainStack(stack)) {
    if (current.kind === "element") {
      const id = attributeValue(current.attrs, HR_ID_ATTRIBUTE);
      if (id !== undefined && HR_ID_PATTERN.test(id)) {
        ids.add(id);
      }
    }
    if (current.kind === "element" || current.kind === "document") {
      for (const child of current.children) {
        stack.push(child);
      }
    }
  }
  return ids;
};

/** 后缀按文档顺序递增：同一文档两次调用逐字节一致，且与遍历起点无关。 */
const uniqueId = (base: string, used: Set<string>): string => {
  if (!used.has(base)) {
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${String(suffix)}`)) {
    suffix += 1;
  }
  return `${base}-${String(suffix)}`;
};

const withHrId = (
  attrs: readonly HtmlAttribute[],
  id: string | undefined,
): readonly HtmlAttribute[] => {
  if (id === undefined) {
    return attrs;
  }
  return attrs.some(([name]) => name === HR_ID_ATTRIBUTE)
    ? attrs.map(([name, value]) =>
        name === HR_ID_ATTRIBUTE ? ([name, id] as const) : ([name, value] as const),
      )
    : [...attrs, [HR_ID_ATTRIBUTE, id] as const];
};

interface AssignContext {
  readonly used: Set<string>;
  readonly injected: string[];
  readonly diagnostics: Diagnostic[];
}

interface WalkState {
  readonly stack: Task[];
  readonly path: string[];
  readonly context: AssignContext;
  /** 祖先路径的滚动摘要：只带一个数走，避免每层元素都去拼整条路径（那是 O(n²)）。 */
  digest: number;
}

/**
 * 种子 = 标签 + 同标签兄弟序号 + 归一化文本前缀 + 祖先路径摘要。
 * 路径摘要用续算的 FNV 值而不是整串祖先路径：深度不再进入单次成本。
 */
const seedOf = (node: HtmlElementNode, siblingIndex: number, digest: number): string =>
  [node.tag, String(siblingIndex), textSample(node), digest.toString(16)].join("\u0000");

const assignId = (
  node: HtmlElementNode,
  entry: { readonly siblingIndex: number; readonly childIndex: number },
  digest: number,
  state: WalkState,
): string => {
  const { context } = state;
  const existing = attributeValue(node.attrs, HR_ID_ATTRIBUTE);
  if (existing !== undefined && HR_ID_PATTERN.test(existing)) {
    return existing;
  }
  const id = uniqueId(`hr-${stableHex8(seedOf(node, entry.siblingIndex, digest))}`, context.used);
  context.used.add(id);
  context.injected.push(id);
  if (existing !== undefined) {
    context.diagnostics.push({
      code: "invalid_hr_id",
      severity: "warning",
      message: `data-hr-id="${existing}" 不合法（空/含空白/非 [a-z0-9-]），已改写为 ${id}`,
      // 路径串只在真要发诊断时拼：正常文档一个诊断都没有，不该为它付遍历成本。
      path: joinPath(state.path.join(">"), pathSegment(node.tag, entry.childIndex)),
    });
  }
  return id;
};

interface ChildSlot {
  /** 同标签兄弟序号：只喂 ID 种子，换写法会让既有 `data-hr-id` 全部变。 */
  readonly siblingIndex: number;
  /** 父 `children` 里的原始下标：只喂诊断路径，与解析层同一口径。 */
  readonly childIndex: number;
}

const childSlots = (children: readonly HtmlNode[]): readonly ChildSlot[] => {
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

type Task =
  | {
      readonly kind: "enter";
      readonly node: HtmlNode;
      readonly sink: Sink;
      readonly insideArticle: boolean;
      readonly siblingIndex: number;
      /** 父 `children` 里的原始下标，诊断路径用。 */
      readonly childIndex: number;
      /** 父节点的路径摘要；进入节点时再续算自己的。 */
      readonly parentDigest: number;
    }
  | { readonly kind: "exit"; readonly parentDigest: number };

/** 子节点收集口：普通情况用数组；根节点用一个回写变量，省掉“根节点是否存在”的死分支。 */
interface Sink {
  readonly push: (node: HtmlNode) => void;
}

const openChildren = (
  children: readonly HtmlNode[],
  state: WalkState,
  sink: HtmlNode[],
  insideArticle: boolean,
): void => {
  const slots = childSlots(children);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    const slot = slots[index];
    if (child !== undefined && slot !== undefined) {
      state.stack.push({
        kind: "enter",
        node: child,
        sink,
        insideArticle,
        siblingIndex: slot.siblingIndex,
        childIndex: slot.childIndex,
        parentDigest: state.digest,
      });
    }
  }
};

const enterElement = (
  task: Extract<Task, { kind: "enter" }>,
  node: HtmlElementNode,
  state: WalkState,
): void => {
  const digest = mixHex(`${node.tag}#${String(task.siblingIndex)}`, task.parentDigest);
  const id = isInjectionTarget(node, task.insideArticle)
    ? assignId(node, task, digest, state)
    : undefined;
  const children: HtmlNode[] = [];
  task.sink.push({ kind: "element", tag: node.tag, attrs: withHrId(node.attrs, id), children });
  state.stack.push({ kind: "exit", parentDigest: task.parentDigest });
  state.path.push(pathSegment(node.tag, task.childIndex));
  state.digest = digest;
  openChildren(node.children, state, children, task.insideArticle || node.tag === "article");
};

const enterNode = (task: Extract<Task, { kind: "enter" }>, state: WalkState): void => {
  if (task.node.kind === "element") {
    enterElement(task, task.node, state);
    return;
  }
  if (task.node.kind === "document") {
    const children: HtmlNode[] = [];
    task.sink.push({ kind: "document", children });
    openChildren(task.node.children, state, children, task.insideArticle);
    return;
  }
  task.sink.push(task.node);
};

export const injectNodeIds = (parsed: ParsedHtml): InjectedNodeIds => {
  const context: AssignContext = {
    used: collectValidIds(parsed.root),
    injected: [],
    diagnostics: [],
  };
  const state: WalkState = { stack: [], path: [], context, digest: HASH_SEED };
  let root: HtmlNode = parsed.root;
  const sink: Sink = {
    push: (node) => {
      root = node;
    },
  };
  state.stack.push({
    kind: "enter",
    node: parsed.root,
    sink,
    insideArticle: false,
    siblingIndex: -1,
    childIndex: -1,
    parentDigest: HASH_SEED,
  });
  for (const task of drainStack(state.stack)) {
    if (task.kind === "exit") {
      state.path.pop();
      state.digest = task.parentDigest;
      continue;
    }
    enterNode(task, state);
  }
  return {
    parsed: { root, diagnostics: [...parsed.diagnostics, ...context.diagnostics] },
    injected: context.injected,
  };
};
