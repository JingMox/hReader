// 这层管：M2.3 diff 的"这块在哪"——块文本、先序槽位、快照基版与重识别（裁定 #4）。
// 只回答位置与基版，不组装响应、不做错误映射（响应在 `annotation-replies.ts`）。

import { join } from "node:path";

import { decodeUtf8 } from "../io/bytes";
import { latestOf, listSnapshots } from "../io/history";
import { historyDirOf } from "../io/paths";
import type { ResolvedTarget } from "../io/paths";
import { parseHtml } from "../html/parse";
import type { DocumentModel } from "../model/constants";
import { toDocumentModel } from "../model/derive";
import type { HandlerContext } from "./handlers";

export const modelOf = (bytes: Uint8Array, label: string): DocumentModel =>
  toDocumentModel(parseHtml(decodeUtf8(bytes, label)));

/** 一个模型节点 + 它的嵌套层数（根 = 0）。 */
interface FlatNode {
  readonly node: DocumentModel;
  readonly depth: number;
}

const flattenWithDepthOf = (model: DocumentModel): readonly FlatNode[] => {
  const nodes: FlatNode[] = [];
  const stack: FlatNode[] = [{ node: model, depth: 0 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    nodes.push(item);
    // 先序 = 文档序：子节点反着入栈，这样"同位置"才有意义（P1-4 位置兜底）。
    // `depth` 是同一处兜底的另一半：只比 tag 会把“嵌套 li”错配到“另一个列表的顶层 li”（同型 P1）。
    const children = item.node.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ node: child, depth: item.depth + 1 });
    }
  }
  return nodes;
};

export const flattenOf = (model: DocumentModel): readonly DocumentModel[] =>
  flattenWithDepthOf(model).map((item) => item.node);

/** 该块在模型里的文本；块不存在 → `undefined`（空块与"块没了"必须分开）。 */
const blockTextOf = (model: DocumentModel, nodeId: string): string | undefined => {
  const nodes = flattenOf(model).filter((node) => node.id === nodeId);
  return nodes.length === 0 ? undefined : nodes.map((node) => node.text).join("\n");
};

/** 快照与当前文档里的"同一槽位"：先序位置 + 同 tag + 同嵌套层（三者缺一就只能算"块没了"）。 */
const sameSlotAs = (previous: FlatNode, slot: FlatNode | undefined): slot is FlatNode =>
  slot?.node.tag === previous.node.tag && slot.depth === previous.depth;

type ReidentifyReason = "block_reidentified" | "block_missing";

interface BlockBasis {
  readonly before: string;
  readonly after: string;
  /**
   * 三档语义（D.4）。C1/`L-05` 后这两个字段不再上 wire，**只作 core 内部的重识别判据**：
   * - 命中：`nodeId` = 命中 id，`originNodeId` 缺省（新旧相同，给了是噪音）；
   * - 重识别成功：`nodeId` = 当前文档里那块的真实 id（旧 id 常已被 patch 换掉），
   *   `originNodeId` = 批注记录里的旧 id，内部用它区分“同一块换了 id”与“另一块顶了位”；
   * - `block_missing`：`nodeId` 与 `originNodeId` 都等于旧 id。
   */
  readonly nodeId: string;
  readonly originNodeId?: string;
  /** 不是文案，是 `degraded` 的驱动输入：只要它出现，响应就必须声明降级。 */
  readonly reason?: ReidentifyReason;
  /** 人话文案：前端直接显示，不做码表翻译。 */
  readonly degradedReason?: string;
}

/** 直接命中：有基版就用基版；历史里没有基版仍是这条批注自己的块，只报缺失（`originNodeId` 同值）。 */
const hitBasisOf = (nodeId: string, after: string, before: string | undefined): BlockBasis =>
  before === undefined
    ? {
        before: "",
        after,
        nodeId,
        originNodeId: nodeId,
        reason: "block_missing",
        degradedReason: "历史里找不到该块",
      }
    : { before, after, nodeId };

/**
 * 为什么会需要"重新识别"：`replace` 保留**片段根**的 id，但片段子树里的 id 由 `injectNodeIds`
 * 按"标签 + 兄弟序 + 文本前缀 + 路径摘要"重算；批注锚在子树里（或藏在片段之外的文桲里）
 * 就可能指向一个已不在盘上的 id。因此三档：`nodeId` 命中 → 正常；未命中但快照里同块在模型
 * 先序里同位置、同 tag、同嵌套层 → 按位置重识别（声明降级）；都不中 → 块已不存在（声明降级）。
 * **不**假装身份已确认。
 */
export const blockBasisOf = async (
  ctx: HandlerContext,
  target: ResolvedTarget,
  current: DocumentModel,
  nodeId: string,
): Promise<BlockBasis> => {
  const direct = blockTextOf(current, nodeId);
  const dir = historyDirOf(target);
  const snapshots = await listSnapshots(ctx.deps, dir);
  const latest = latestOf(snapshots);
  if (latest === undefined) {
    // 工作区还没有任何快照：当前文档里块还在 → 没有基版可比，整块都算新增（不降级）；
    // 块也一起没了 → 两侧文本都是空串，但**不是"无变化"**：`degraded:false` 会被读成
    // "字符级对比、两版一致"，而真相是块丢了（裁定 B，见 annotations-diff-basis.test.ts）。
    return direct === undefined
      ? {
          before: "",
          after: "",
          nodeId,
          originNodeId: nodeId,
          reason: "block_missing",
          degradedReason: "历史与当前文档都找不到该块",
        }
      : { before: "", after: direct, nodeId };
  }
  const latestModel = modelOf(
    await ctx.deps.fs.readFile(join(dir, latest.name)),
    `${target.realPath}#${latest.name}`,
  );
  if (direct === undefined) {
    return await reidentifyOf(ctx, target, { current, latestModel, nodeId, snapshots });
  }
  return hitBasisOf(nodeId, direct, blockTextOf(latestModel, nodeId));
};

/** ID 已重建时按先序位置找"同一块"（位置 + tag + 嵌套层）；找不到同槽位的替身就老实报缺失。 */
interface ReidentifyArgs {
  readonly current: DocumentModel;
  readonly latestModel: DocumentModel;
  readonly nodeId: string;
  readonly snapshots: Awaited<ReturnType<typeof listSnapshots>>;
}

/** 快照里这块的基版文本：就地改过就用快照里的新文本，否则用旧文本。 */
const beforeOfSlot = (previous: FlatNode, latestSlot: FlatNode | undefined): string =>
  sameSlotAs(previous, latestSlot) ? latestSlot.node.text : previous.node.text;

/** 同一槽位的两档：当前文档里同位置同 tag 同层 → 重识别成功；否则块已不存在。 */
const slotBasisOf = (
  previous: FlatNode,
  latestSlot: FlatNode | undefined,
  replacement: FlatNode | undefined,
  originNodeId: string,
): BlockBasis =>
  sameSlotAs(previous, replacement)
    ? {
        before: beforeOfSlot(previous, latestSlot),
        after: replacement.node.text,
        // 重识别后 ID 已变：`nodeId` 给当前文档的真实 id，旧 id 只能当 `originNodeId` 用。
        nodeId: replacement.node.id,
        originNodeId,
        reason: "block_reidentified",
        degradedReason: "该块 ID 已随内容变化重建，按位置重新识别",
      }
    : {
        before: beforeOfSlot(previous, latestSlot),
        after: "",
        nodeId: originNodeId,
        originNodeId,
        reason: "block_missing",
        degradedReason: "当前文档里找不到该块",
      };

const reidentifyOf = async (
  ctx: HandlerContext,
  target: ResolvedTarget,
  { current, latestModel, nodeId, snapshots }: ReidentifyArgs,
): Promise<BlockBasis> => {
  const dir = historyDirOf(target);
  const currentFlat = flattenWithDepthOf(current);
  for (const snapshot of snapshots.toReversed()) {
    const model = modelOf(
      await ctx.deps.fs.readFile(join(dir, snapshot.name)),
      `${target.realPath}#${snapshot.name}`,
    );
    const previousFlat = flattenWithDepthOf(model);
    const index = previousFlat.findIndex((item) => item.node.id === nodeId);
    const previous = previousFlat[index];
    if (previous === undefined) continue;
    const latestSlot = flattenWithDepthOf(latestModel)[index];
    return slotBasisOf(previous, latestSlot, currentFlat[index], nodeId);
  }
  return {
    before: "",
    after: "",
    nodeId,
    originNodeId: nodeId,
    reason: "block_missing",
    degradedReason: "历史里找不到该块",
  };
};
