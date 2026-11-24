// 这层管：patch 的纯变换（校验 → 定位 → 只改写目标源码区间 → 片段 ID 重注入）；不碰 IO、不改入参。

import type { Diagnostic, HtmlElementNode, HtmlNode, SourceSpan } from "../../html/constants";
import { ARTICLE_TAG, HR_ID_ATTRIBUTE } from "../../html/constants";
import { injectNodeIds } from "../../html/inject";
import { injectSeedOf } from "../../html/seed";
import { parseHtml } from "../../html/parse";
import { serializeHtml } from "../../html/serialize";
import { ZERO_SPAN } from "../../html/span";
import { HrError } from "../../hr-error";
import { attributeValue, isPatchableTarget } from "./attrs";
import {
  PATCH_ACTIONS,
  ROOT_TARGET_ID,
  type PatchAction,
  type PatchOutcome,
  type PatchRequest,
  type ReplacedId,
} from "./constants";
import { assertFragmentFits } from "./content";
import { fragmentIdWarnings, parseFragmentWithDiagnostics } from "./fragment";
import { collectHrIds, stripHrIds } from "./ids";
import { findElement, parentElementOf } from "./locate";

/** 无内容的 `delete` 与必须带内容的四种分开：后面的分支因此不需要"html 是否缺失"的二次判定。 */
type FragmentRequest =
  | { readonly action: "delete" }
  | { readonly action: Exclude<PatchAction, "delete">; readonly html: string };

interface Located {
  readonly target: HtmlElementNode;
  readonly targetId: string;
  /** 目标就是最外层 `<article>`：只允许 replace / append，且按"内容区域"而非整元素换。 */
  readonly isRoot: boolean;
}

interface Splice {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly newIds: readonly string[];
  readonly replacedIds: readonly ReplacedId[];
  /** 片段自己的解析诊断（如 `duplicate_attribute` 属性被吞）：上浮给调用方当 warning。 */
  readonly warnings: readonly Diagnostic[];
}

interface Injected {
  readonly text: string;
  readonly newIds: readonly string[];
  /** 注入后片段根元素拿到的 id：`replace` 靠它把旧 id 映射到新 id。 */
  readonly rootId: string | undefined;
}

const NO_DIAGNOSTICS: readonly Diagnostic[] = [];

/** locations 模式下每个元素都有 span（隐含骨架为零宽），这里只取值，不回答"元素在不在"（P2-2）。 */
const spanOrZero = (target: HtmlElementNode): SourceSpan => ({ ...ZERO_SPAN, ...target.span });

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
    // 全文一个 id 都没有：不是“id 写错了”，而是这份文档从没规范化过（B-03）。
    if (collectHrIds(root).length === 0) {
      throw new HrError(
        "needs_normalize",
        `文档里没有任何 data-hr-id（目标 ${targetId}）：先 normalize 再 patch`,
      );
    }
    throw new HrError("node_not_found", `找不到 data-hr-id="${targetId}" 的元素`);
  }
  if (!isPatchableTarget(found)) {
    throw new HrError(
      "invalid_input",
      `data-hr-id="${targetId}" 落在 <${found.tag}> 上，patch 目标必须是可寻址且可作目标的块级元素`,
    );
  }
  return found;
};

const locateTarget = (root: HtmlNode, targetId: string): Located => {
  if (targetId.length === 0) throw new HrError("invalid_input", "targetId 不能为空");
  const article = findElement(root, (node) => node.tag === ARTICLE_TAG);
  if (targetId === ROOT_TARGET_ID) {
    if (article === undefined) throw new HrError("node_not_found", "文档里没有最外层 <article>");
    return { target: article, targetId, isRoot: true };
  }
  const target = locateById(root, targetId);
  // 按身份判而不是按 tag：`<article id="root">` 这种"id 撞到骨架"的输入也必须走 root 规则。
  return { target, targetId, isRoot: target === article };
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

/** 被 replace 掉的节点连同 ID 消失：从保留集摘掉，重复 patch 才能重导出同 ID 保持幂等（P1-8）。 */
const withoutSelfId = (reserved: readonly string[], target: HtmlElementNode): readonly string[] => {
  const self = attributeValue(target.attrs, HR_ID_ATTRIBUTE);
  // self 缺失时 `id !== undefined` 恒真，效果等同“原样返回”，不必再分支。
  return reserved.filter((id) => id !== self);
};

/** 摘掉整个被替换区间的 ID，避免复算原 ID 被迫带 `-2` 后缀导致未改子树锚点丢失（④）。 */
const withoutReplacedIds = (
  reserved: readonly string[],
  target: HtmlElementNode,
): readonly string[] => {
  const gone = new Set(collectHrIds(target));
  gone.add(String(attributeValue(target.attrs, HR_ID_ATTRIBUTE)));
  return reserved.filter((id) => !gone.has(id));
};

interface ReplaceScope {
  readonly reserved: readonly string[];
  /** 片段根在文档里的原位置：`root` 目标不适用。 */
  readonly seed: ReturnType<typeof injectSeedOf>;
  /** 片段新根要继承的目标 id：`replace` 时 id 归产品所有，不能跟着新内容重算。 */
  readonly rootId: string | undefined;
}

/** `replace` 的保留集、种子与根 id：`root` 目标只摘自身 ID、不继承根 id。 */
const replaceScopeOf = (
  root: HtmlNode,
  located: Located,
  reserved: readonly string[],
): ReplaceScope =>
  located.isRoot
    ? { reserved: withoutSelfId(reserved, located.target), seed: undefined, rootId: undefined }
    : {
        reserved: withoutReplacedIds(reserved, located.target),
        seed: injectSeedOf(root, located.target),
        rootId: attributeValue(located.target.attrs, HR_ID_ATTRIBUTE),
      };

const rootIdOf = (node: HtmlNode): string | undefined =>
  node.kind === "element" ? attributeValue(node.attrs, HR_ID_ATTRIBUTE) : undefined;

const injectFragment = (
  fragment: HtmlNode,
  scope: Pick<ReplaceScope, "reserved" | "seed" | "rootId">,
): Injected => {
  const injected = injectNodeIds(
    { root: fragment, diagnostics: NO_DIAGNOSTICS },
    {
      reserved: scope.reserved,
      insideArticle: true,
      rootSeed: scope.seed,
      rootId: scope.rootId,
    },
  );
  return {
    text: serializeHtml(injected.parsed),
    newIds: injected.injected,
    rootId: rootIdOf(injected.parsed.root),
  };
};

/** `from` = 片段根自带的 id，`to` = 新根继承的目标 id；无自带 id 或 root 目标为空。 */
const replacedIdsOf = (
  located: Located,
  action: PatchAction,
  fragmentRootId: string | undefined,
  injected: Injected,
): readonly ReplacedId[] => {
  if (action !== "replace" || located.isRoot) return [];
  const to = injected.rootId;
  if (fragmentRootId === undefined || to === undefined || to === fragmentRootId) return [];
  return [{ from: fragmentRootId, to }];
};

/** 片段最终落在谁的子节点里：`append` 落在目标自身，其余三种落在目标原来的位置（父容器）。 */
const containerOf = (
  root: HtmlNode,
  located: Located,
  action: PatchAction,
): HtmlElementNode | undefined =>
  action === "append" ? located.target : parentElementOf(root, located.target);

/** `delete` 就是"把目标区间替换成空串"：不注入、不产新 id，警告自然也没有。 */
const deleteSplice = (span: SourceSpan): Splice => ({
  from: span.start,
  to: span.end,
  text: "",
  newIds: [],
  replacedIds: [],
  warnings: [],
});

/** 零跨度说明文件里尚无该元素源码区间（未拆开的隐含 `<p>`）：拦 `delete`/`replace`，放行插入类。 */
const assertByteSpan = (span: SourceSpan, targetId: string, action: PatchAction): void => {
  if (action !== "delete" && action !== "replace") return;
  if (span.start !== span.end) return;
  throw new HrError(
    "needs_normalize",
    `目标 ${targetId} 在文件里没有字节跨度（文档尚未 normalize 拆分内联段），先跑 \`hr normalize --write\``,
  );
};

const spliceFor = (
  root: HtmlNode,
  located: Located,
  request: FragmentRequest,
  reserved: readonly string[],
): Splice | undefined => {
  const span = spanOrZero(located.target);
  if (located.isRoot && request.action !== "replace" && request.action !== "append") {
    throw rootRejection(request.action);
  }
  assertByteSpan(span, located.targetId, request.action);
  if (request.action === "delete") return deleteSplice(span);
  // 片段的解析诊断不再静默丢：`duplicate_attribute` 这类意味着“写出去的字节里少了东西”，必须让用户看见。
  const {
    root: fragment,
    warnings,
    rootId: fragmentRootId,
  } = parseFragmentWithDiagnostics(request.html);
  const container = containerOf(root, located, request.action);
  if (container !== undefined) assertFragmentFits(container, fragment);
  // #12：内容相同就原样返回，不重新注入（否则同一内容重复 patch 会一直换 ID）。
  if (request.action === "replace" && sameContent(located, fragment)) return undefined;
  const scope =
    request.action === "replace"
      ? replaceScopeOf(root, located, reserved)
      : { reserved, seed: undefined, rootId: undefined };
  const injected = injectFragment(fragment, scope);
  return {
    ...rangeFor(span, request.action, located.isRoot),
    ...injected,
    replacedIds: replacedIdsOf(located, request.action, fragmentRootId, injected),
    warnings: [...warnings, ...fragmentIdWarnings(fragmentRootId, injected.rootId)],
  };
};

/** 纯字符串进出：只拼接目标元素的源码区间，等价内容再 patch 一次不产新 ID、不改文件。 */
export const applyPatch = (html: string, request: PatchRequest): PatchOutcome => {
  if (!isKnownAction(request.action)) {
    throw new HrError("invalid_input", `未知 action：${request.action}`);
  }
  const fragmentRequest = fragmentRequestOf(request);
  const parsed = parseHtml(html, { locations: true });
  const located = locateTarget(parsed.root, request.targetId);
  const splice = spliceFor(parsed.root, located, fragmentRequest, collectHrIds(parsed.root));
  if (splice === undefined) {
    return { html, newIds: [], replacedIds: [], changed: false, warnings: [] };
  }
  // 走到这里必然有字节变化：#12 的等值分支已在上面提前返回。
  return {
    html: `${html.slice(0, splice.from)}${splice.text}${html.slice(splice.to)}`,
    newIds: splice.newIds,
    replacedIds: splice.replacedIds,
    changed: true,
    warnings: splice.warnings,
  };
};
