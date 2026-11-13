// 这层管：patch 的纯变换（校验 → 定位 → 只改写目标源码区间 → 片段 ID 重注入）；不碰 IO、不改入参。

import type { Diagnostic, HtmlElementNode, HtmlNode, SourceSpan } from "../../html/constants";
import { ARTICLE_TAG, HR_ID_ATTRIBUTE } from "../../html/constants";
import { injectNodeIds } from "../../html/inject";
import { parseHtml } from "../../html/parse";
import { serializeHtml } from "../../html/serialize";
import { HrError } from "../../hr-error";
import { attributeValue, isBlockLevel } from "./attrs";
import {
  PATCH_ACTIONS,
  ROOT_TARGET_ID,
  type PatchAction,
  type PatchOutcome,
  type PatchRequest,
} from "./constants";
import { parseFragment } from "./fragment";
import { collectHrIds, stripHrIds } from "./ids";
import { findElement } from "./locate";

/** 无内容的 `delete` 与必须带内容的四种分开：后面的分支因此不需要"html 是否缺失"的二次判定。 */
type FragmentRequest =
  | { readonly action: "delete" }
  | { readonly action: Exclude<PatchAction, "delete">; readonly html: string };

interface Located {
  readonly target: HtmlElementNode;
  /** 目标就是最外层 `<article>`：只允许 replace / append，且按"内容区域"而非整元素换。 */
  readonly isRoot: boolean;
}

interface Splice {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly newIds: readonly string[];
}

interface Injected {
  readonly text: string;
  readonly newIds: readonly string[];
}

const NO_DIAGNOSTICS: readonly Diagnostic[] = [];

const ZERO_SPAN: SourceSpan = { start: 0, end: 0, innerStart: 0, innerEnd: 0 };

/** locations 模式下每个元素都有 span（隐含骨架是零宽），这里用数据合并代替缺失分支。 */
const spanOf = (target: HtmlElementNode): SourceSpan => ({ ...ZERO_SPAN, ...target.span });

const isKnownAction = (value: string): boolean => PATCH_ACTIONS.some((action) => action === value);

const fragmentRequestOf = (request: PatchRequest): FragmentRequest => {
  if (request.action === "delete") {
    if (request.html !== undefined) throw new HrError("invalid_input", "delete 不接受 html");
    return { action: "delete" };
  }
  if (request.html === undefined) throw new HrError("invalid_input", `${request.action} 需要 html`);
  return { action: request.action, html: request.html };
};

const rootRejection = (action: string): HrError =>
  new HrError(
    "invalid_input",
    `root 目标只支持 replace/append；${action} 会删掉或拆散 <article> 本身`,
  );

const locateById = (root: HtmlNode, targetId: string): HtmlElementNode => {
  const found = findElement(
    root,
    (node) => attributeValue(node.attrs, HR_ID_ATTRIBUTE) === targetId,
  );
  if (found === undefined) {
    throw new HrError("node_not_found", `找不到 data-hr-id="${targetId}" 的元素`);
  }
  if (!isBlockLevel(found)) {
    throw new HrError(
      "invalid_input",
      `data-hr-id="${targetId}" 落在 <${found.tag}> 上，patch 目标必须是块级元素`,
    );
  }
  return found;
};

const locateTarget = (root: HtmlNode, targetId: string): Located => {
  if (targetId.length === 0) throw new HrError("invalid_input", "targetId 不能为空");
  const article = findElement(root, (node) => node.tag === ARTICLE_TAG);
  if (targetId === ROOT_TARGET_ID) {
    if (article === undefined) throw new HrError("node_not_found", "文档里没有最外层 <article>");
    return { target: article, isRoot: true };
  }
  const target = locateById(root, targetId);
  // 按身份判而不是按 tag：`<article id="root">` 这种"id 撞到骨架"的输入也必须走 root 规则。
  return { target, isRoot: target === article };
};

/** #12 的"规范内容"：剥掉 `data-hr-id` 后序列化；重复执行不会因为换 ID 而"看起来变了"。 */
const contentKey = (nodes: readonly HtmlNode[]): string =>
  serializeHtml({
    root: { kind: "document", children: nodes.map((node) => stripHrIds(node)) },
    diagnostics: NO_DIAGNOSTICS,
  });

/** root 目标比的是 `<article>` 的子节点：剥 ID 后的规范形式相同才叫"内容没变"（#12）。 */
const sameContent = (located: Located, fragment: HtmlNode): boolean =>
  contentKey(located.isRoot ? located.target.children : [located.target]) ===
  contentKey([fragment]);

const rangeFor = (
  span: SourceSpan,
  action: PatchAction,
  isRoot: boolean,
): { from: number; to: number } => {
  if (action === "insert_before") return { from: span.start, to: span.start };
  if (action === "insert_after") return { from: span.end, to: span.end };
  if (action === "append") return { from: span.innerEnd, to: span.innerEnd };
  return isRoot ? { from: span.innerStart, to: span.innerEnd } : { from: span.start, to: span.end };
};

/**
 * 被 replace 掉的节点连同它的 ID 一起消失：把该 ID 从保留集里摘掉，同一内容重复 patch
 * 才能重新推导出同一个 ID、从而逐字节幂等（P1-8）。
 */
const withoutSelfId = (reserved: readonly string[], target: HtmlElementNode): readonly string[] => {
  const self = attributeValue(target.attrs, HR_ID_ATTRIBUTE);
  // self 缺失时 `id !== undefined` 恒真，效果等同“原样返回”，不必再分支。
  return reserved.filter((id) => id !== self);
};

const injectFragment = (fragment: HtmlNode, reserved: readonly string[]): Injected => {
  const injected = injectNodeIds(
    { root: fragment, diagnostics: NO_DIAGNOSTICS },
    { reserved, insideArticle: true },
  );
  return { text: serializeHtml(injected.parsed), newIds: injected.injected };
};

const spliceFor = (
  located: Located,
  request: FragmentRequest,
  reserved: readonly string[],
): Splice | undefined => {
  const span = spanOf(located.target);
  if (request.action === "delete") {
    if (located.isRoot) throw rootRejection("delete");
    return { from: span.start, to: span.end, text: "", newIds: [] };
  }
  if (located.isRoot && request.action !== "replace" && request.action !== "append") {
    throw rootRejection(request.action);
  }
  const fragment = parseFragment(request.html);
  // #12：内容相同就原样返回，不重新注入（否则同一内容重复 patch 会一直换 ID）。
  if (request.action === "replace" && sameContent(located, fragment)) return undefined;
  const kept = request.action === "replace" ? withoutSelfId(reserved, located.target) : reserved;
  const injected = injectFragment(fragment, kept);
  return { ...rangeFor(span, request.action, located.isRoot), ...injected };
};

/**
 * 纯字符串进出：只拼接目标元素的源码区间，其余字节逐字保持原样；`changed` 按字节相等判定，
 * 因此"等价内容再 patch 一次"不会产生新 ID、也不会改文件。
 */
export const applyPatch = (html: string, request: PatchRequest): PatchOutcome => {
  if (!isKnownAction(request.action)) {
    throw new HrError("invalid_input", `未知 action：${request.action}`);
  }
  const fragmentRequest = fragmentRequestOf(request);
  const parsed = parseHtml(html, { locations: true });
  const located = locateTarget(parsed.root, request.targetId);
  const splice = spliceFor(located, fragmentRequest, collectHrIds(parsed.root));
  if (splice === undefined) return { html, newIds: [], changed: false };
  // 走到这里必然有字节变化：#12 的等值分支已在上面提前返回。
  return {
    html: `${html.slice(0, splice.from)}${splice.text}${html.slice(splice.to)}`,
    newIds: splice.newIds,
    changed: true,
  };
};
