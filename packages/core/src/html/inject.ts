// 这层管：给 `<article>` 内的块级元素分配稳定 `data-hr-id`；不解析、不序列化、不改入参。

import {
  ADDRESSABLE_TAGS,
  ARTICLE_TAG,
  type Diagnostic,
  HR_ID_ATTRIBUTE,
  HR_ID_PATTERN,
  type HtmlElementNode,
  type HtmlNode,
  type ParsedHtml,
} from "./constants";
import { HASH_SEED, mixHex, stableHex8 } from "./hash";
import { attributeValue, collectValidIdCounts, uniqueId, withHrId } from "./hrIds";
import { joinPath, pathSegment } from "./path";
import { type InjectSeed, ROOT_SEED } from "./seed";
import { childSlots } from "./slots";
import { drainStack } from "./stack";
import { textSamplesOf } from "./text";

export interface InjectedNodeIds {
  readonly parsed: ParsedHtml;
  readonly injected: readonly string[];
}

const TEXT_SAMPLE_LENGTH = 64;

/** 注入目标：最外层 `<article>` 自身，以及 article 内的可寻址元素（嵌套 article 不另注入）。 */
const isInjectionTarget = (node: HtmlElementNode, insideArticle: boolean): boolean =>
  node.tag === ARTICLE_TAG ? !insideArticle : insideArticle && ADDRESSABLE_TAGS.has(node.tag);

/**
 * 最多取 64 个字符；只按这个前缀算 ID，不看子树第 65 个字符之后。
 * 前缀由 `textSamplesOf` 一次算满全树（逐个 `textSampleOf` 在深嵌套下是 O(n²)），这里只做空白归一。
 */
const seedText = (node: HtmlNode, state: WalkState): string => {
  // `textSamplesOf` 的后序遍历给全树每个节点都写前缀（html/text.ts），`get` 必命中；`?? ""` 只是签名。
  /* v8 ignore next */
  const sample = state.samples.get(node) ?? "";
  return sample.replace(/\s+/gu, " ").trim();
};

interface AssignContext {
  readonly used: Set<string>;
  readonly injected: string[];
  readonly diagnostics: Diagnostic[];
  /** 全文合法 id 的出现次数：判"重复 id 只保留第一个"用。 */
  readonly idCounts: ReadonlyMap<string, number>;
  /** 已经原样留下的重复 id：第二次遇到它才重分配（先序，先到先得）。 */
  readonly kept: Set<string>;
  /** `replace` 的片段根要继承的目标 id：id 归产品所有，片段自己算出来的不算数。 */
  readonly rootId: string | undefined;
}

interface WalkState {
  readonly stack: Task[];
  readonly path: string[];
  readonly context: AssignContext;
  /** 每个节点的文本前缀：`seedOf` 要用，一次算满全树（见 `textSamplesOf`）。 */
  readonly samples: ReadonlyMap<HtmlNode, string>;
  /** 祖先路径的滚动摘要：只带一个数走，避免每层元素都去拼整条路径（那是 O(n²)）。 */
  digest: number;
}

/**
 * 种子 = 标签 + 同标签兄弟序号 + 归一化文本前缀 + 祖先路径摘要。
 * 路径摘要用续算的 FNV 值而不是整串祖先路径：深度不再进入单次成本。
 */
const seedOf = (
  node: HtmlElementNode,
  siblingIndex: number,
  digest: number,
  text: string,
): string => [node.tag, String(siblingIndex), text, digest.toString(16)].join("\u0000");

/**
 * 显式 id 能不能原样留下：格式合法**且**（全文只出现一次，或是重复 id 里的第一个）。
 * 先序遍历保证“第一个”就是文档里第一个——其余重分配。
 */
const isKeepableId = (id: string, state: WalkState): boolean =>
  HR_ID_PATTERN.test(id) && (state.context.idCounts.get(id) === 1 || !state.context.kept.has(id));

const assignId = (
  node: HtmlElementNode,
  entry: { readonly siblingIndex: number; readonly childIndex: number },
  digest: number,
  state: WalkState,
): string => {
  const { context } = state;
  const existing = attributeValue(node.attrs, HR_ID_ATTRIBUTE);
  if (existing !== undefined && isKeepableId(existing, state)) {
    context.used.add(existing);
    context.kept.add(existing);
    return existing;
  }
  const seed = seedOf(node, entry.siblingIndex, digest, seedText(node, state));
  const id = uniqueId(`hr-${stableHex8(seed)}`, context.used);
  context.used.add(id);
  context.injected.push(id);
  if (existing !== undefined) {
    const duplicated = HR_ID_PATTERN.test(existing);
    context.diagnostics.push({
      code: duplicated ? "id_reassigned" : "invalid_hr_id",
      severity: "warning",
      message: duplicated
        ? `重复的 data-hr-id="${existing}"（只保留第一个），已改名为 ${id}`
        : `data-hr-id="${existing}" 不合法（应为 ${HR_ID_PATTERN.source}），已改写为 ${id}`,
      // 路径串只在真要发诊断时拼：正常文档一个诊断都没有，不该为它付遍历成本。
      path: joinPath(state.path.join(">"), pathSegment(node.tag, entry.childIndex)),
    });
  }
  return id;
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

/**
 * 这个节点写不写 id：根任务（`childIndex === -1`）只可能是遍历起点，`replace` 给它的目标 id
 * 优先于"按片段内容再算一个"——id 归产品所有，换内容不该换锚点。
 */
const idOf = (
  task: Extract<Task, { kind: "enter" }>,
  node: HtmlElementNode,
  digest: number,
  state: WalkState,
): string | undefined => {
  if (task.childIndex === -1 && state.context.rootId !== undefined) return state.context.rootId;
  return isInjectionTarget(node, task.insideArticle)
    ? assignId(node, task, digest, state)
    : undefined;
};

const enterElement = (
  task: Extract<Task, { kind: "enter" }>,
  node: HtmlElementNode,
  state: WalkState,
): void => {
  const digest = mixHex(`${node.tag}#${String(task.siblingIndex)}`, task.parentDigest);
  const id = idOf(task, node, digest, state);
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

/**
 * `reserved` 是调用方已知占用的 ID（如补丁片段要避开整篇文档已有 ID）；`insideArticle` 用于把
 * 片段本身当作注入根。两者都只在 patch 路径上出现，默认值与 M1.2 行为逐字一致。
 * `rootSeed` 同属 patch 路径：给了它，片段根就按它在文档里的原位置复算 ID（`replace` 的锚点保持）。
 */
/** 一次注入遍历的启动状态：`result()` 取遍历后写回的根（外壳层可能被替换）。 */
interface Walk {
  readonly state: WalkState;
  readonly result: () => HtmlNode;
}

/** 注入选项：`reserved`/`insideArticle`/`rootSeed`/`rootId` 只在 patch 路径出现，缺省与 M1.2 逐字一致。 */
interface InjectOptions {
  /** 调用方已知占用的 ID（如补丁片段要避开整篇文档已有 ID）。 */
  readonly reserved?: readonly string[];
  /** 把片段自身当作注入根。 */
  readonly insideArticle?: boolean;
  /** 片段根在文档里的原位置：给了它就按原位置复算 ID。 */
  readonly rootSeed?: InjectSeed | undefined;
  /** `replace` 的新根直接继承目标 id（id 归产品所有，不跟内容重算）。 */
  readonly rootId?: string | undefined;
}

/** 遍历起点：`used` 预置全文已有 id（含重复的，重分配时不能再撞上），`kept` 记录已保留的重复 id。 */
const assignContextOf = (parsed: ParsedHtml, options: InjectOptions): AssignContext => {
  const idCounts = collectValidIdCounts(parsed.root);
  return {
    used: new Set([
      ...idCounts.keys(),
      ...(options.reserved ?? []),
      ...(options.rootId === undefined ? [] : [options.rootId]),
    ]),
    injected: [],
    diagnostics: [],
    idCounts,
    kept: new Set<string>(),
    rootId: options.rootId,
  };
};

const beginWalk = (parsed: ParsedHtml, options: InjectOptions): Walk => {
  const rootSeed = options.rootSeed ?? ROOT_SEED;
  const state: WalkState = {
    stack: [],
    path: [],
    context: assignContextOf(parsed, options),
    samples: textSamplesOf(parsed.root, TEXT_SAMPLE_LENGTH),
    digest: HASH_SEED,
  };
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
    insideArticle: options.insideArticle === true,
    siblingIndex: rootSeed.siblingIndex,
    childIndex: -1,
    parentDigest: rootSeed.parentDigest,
  });
  return { state, result: () => root };
};

export const injectNodeIds = (parsed: ParsedHtml, options: InjectOptions = {}): InjectedNodeIds => {
  const walk = beginWalk(parsed, options);
  for (const task of drainStack(walk.state.stack)) {
    if (task.kind === "exit") {
      walk.state.path.pop();
      walk.state.digest = task.parentDigest;
      continue;
    }
    enterNode(task, walk.state);
  }
  const { context } = walk.state;
  return {
    parsed: { root: walk.result(), diagnostics: [...parsed.diagnostics, ...context.diagnostics] },
    injected: context.injected,
  };
};
