// 这层管：按文档顺序找第一个匹配元素并数出总匹配数；不改树、不判外壳、不序列化。

import type { HtmlElementNode, HtmlNode } from "../../html/constants";
import { HrError } from "../../hr-error";
import { joinPath, pathSegment } from "../../html/path";
import { drainStack } from "../../html/stack";
import { identifierOf } from "./attrs";
import { CANDIDATE_LIMIT } from "./constants";
import type { Selector } from "./constants";

interface Resolved {
  readonly node: HtmlElementNode;
  /** 节点的定位串，与解析层诊断的 `path` 同一写法（`article[0]>section[1]`）。 */
  readonly path: string;
  readonly matches: number;
  /** 命中元素各自的 `data-hr-id`（没 id 的不收），文档序，最多 `CANDIDATE_LIMIT` 个。 */
  readonly ids: readonly string[];
  /** 命中且有 `data-hr-id` 的元素总数（只能 patch 这些）。 */
  readonly addressable: number;
}

interface Entry {
  readonly node: HtmlElementNode;
  /** 在父节点里同标签兄弟中的序号（从 0 起）：`:nth-of-type(n)` 只用它。 */
  readonly tagIndex: number;
  /** 父 `children` 里的原始下标：`path` 只用它（与解析层同一口径）。 */
  readonly childIndex: number;
  readonly parentTag: string | undefined;
}

type Step = { readonly kind: "enter"; readonly entry: Entry } | { readonly kind: "exit" };

const matches = (entry: Entry, selector: Selector): boolean => {
  if (selector.kind === "id") {
    return identifierOf(entry.node) === selector.id;
  }
  if (entry.node.tag !== selector.tag) {
    return false;
  }
  return selector.kind === "tag"
    ? true
    : entry.parentTag === selector.parent && entry.tagIndex === selector.index - 1;
};

const seedChildren = (
  children: readonly HtmlNode[],
  parentTag: string | undefined,
  steps: Step[],
): void => {
  const counts = new Map<string, number>();
  const entries: Entry[] = [];
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    if (child?.kind !== "element") {
      continue;
    }
    const tagIndex = counts.get(child.tag) ?? 0;
    counts.set(child.tag, tagIndex + 1);
    entries.push({ node: child, tagIndex, childIndex, parentTag });
  }
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    const entry = entries[position];
    if (entry !== undefined) {
      steps.push({ kind: "enter", entry });
    }
  }
};

/** 根可能是 `document`（整页）或元素（片段），两者都只透传 `children`。 */
const childNodesOf = (node: HtmlNode): readonly HtmlNode[] =>
  "children" in node ? node.children : [];

const pathOf = (segments: readonly string[], segment: string): string =>
  joinPath(segments.join(">"), segment);

/** 命中元素自己的 `data-hr-id`（没 id 的不收）；只收前 `CANDIDATE_LIMIT` 个，但 `addressable` 是全量。 */
interface Tally {
  readonly ids: string[];
  addressable: number;
}

const noteMatch = (node: HtmlElementNode, tally: Tally): void => {
  const id = identifierOf(node);
  if (id === undefined) return;
  tally.addressable += 1;
  if (tally.ids.length < CANDIDATE_LIMIT) {
    tally.ids.push(id);
  }
};

/** 单趟先序：`matches` 全量计数，节点/路径只给第一个匹配留；候选 id 只留前 `CANDIDATE_LIMIT` 个。 */
export const resolveSelector = (root: HtmlNode, selector: Selector, source: string): Resolved => {
  const steps: Step[] = [];
  const segments: string[] = [];
  let first: { readonly node: HtmlElementNode; readonly path: string } | undefined;
  const tally: Tally = { ids: [], addressable: 0 };
  let total = 0;
  seedChildren(childNodesOf(root), undefined, steps);
  for (const step of drainStack(steps)) {
    if (step.kind === "exit") {
      segments.pop();
      continue;
    }
    const segment = pathSegment(step.entry.node.tag, step.entry.childIndex);
    if (matches(step.entry, selector)) {
      total += 1;
      noteMatch(step.entry.node, tally);
      first ??= { node: step.entry.node, path: pathOf(segments, segment) };
    }
    segments.push(segment);
    steps.push({ kind: "exit" });
    seedChildren(step.entry.node.children, step.entry.node.tag, steps);
  }
  if (first === undefined) {
    throw new HrError("node_not_found", `选择器 ${JSON.stringify(source)} 没有匹配到任何节点`);
  }
  return {
    node: first.node,
    path: first.path,
    matches: total,
    ids: tally.ids,
    addressable: tally.addressable,
  };
};
