// 这层管：补 parse5 在 quirks 文档里没做的 `<p>` 隐式结束（`<p>前<table>` → `<p>前</p><table>`）；不做校验、不碰 IO。

import {
  HR_ID_ATTRIBUTE,
  type HtmlAttribute,
  type HtmlElementNode,
  type HtmlNode,
  P_CLOSING_TAGS,
  type ParsedHtml,
  type SourceSpan,
} from "./constants";
import { attributeValue } from "./hrIds";
import { drainStack } from "./stack";

/** 一段输出：`children` 是这一段的子节点（**未**处理过），复制后逐层填回。 */
interface Piece {
  readonly node: HtmlElementNode;
  readonly children: readonly HtmlNode[];
}

/**
 * 深度判据：quirks 下 parse5 会把 `<table>` 原样留在 `<p>` 里，中间隔一层 `<span>`/`<b>` 也不挪走
 * （no-quirks 与 `<div>`/`<ul>` 这类解析器自己就会关 `p`）。因此"这个子节点要不要挪出去"不能只看它自己的标签：
 * 只看直接子节点的写法会漏掉 `<p>a<span><table>`，那份树随后被内容模型判非法。
 */
const hasBlockInside = (element: HtmlElementNode): boolean => {
  const stack: HtmlNode[] = [...element.children];
  for (const node of drainStack(stack)) {
    if (node.kind !== "element") continue;
    if (P_CLOSING_TAGS.has(node.tag)) return true;
    stack.push(...node.children);
  }
  return false;
};

/** `<p>` 只能装行内内容，碰上这些（或**内含**这些）就断成兄弟。 */
const splitsParagraph = (node: HtmlNode): boolean =>
  node.kind === "element" && (P_CLOSING_TAGS.has(node.tag) || hasBlockInside(node));

/** 去掉 `data-hr-id`：分裂出来的后续分段由注入阶段重新分配 id（`html/inject.ts` 在解析之后跑）。 */
const withoutHrId = (attrs: readonly HtmlAttribute[]): readonly HtmlAttribute[] =>
  attrs.filter(([name]) => name !== HR_ID_ATTRIBUTE);

/**
 * 一个 `<p>` 分段的骨架：只保留它自己那段内容的区间。
 * 首个分段带原开始标签（`start` 从 `<p` 算起、`innerStart` 用它），后续分段在源码里没有自己的标签，
 * 区间退化成"内容区间"。`end` 取最后保留子节点的结束处：p 之后的空白与 `</p>` 不归它。
 */
const paragraphPiece = (
  paragraph: HtmlElementNode,
  start: number,
  end: number,
  first: boolean,
): HtmlElementNode => {
  const own = paragraph.span;
  const span: SourceSpan = {
    start,
    end,
    innerStart: first ? (own?.innerStart ?? start) : start,
    innerEnd: end,
  };
  return {
    ...paragraph,
    attrs: first ? paragraph.attrs : withoutHrId(paragraph.attrs),
    ...(own === undefined ? {} : { span }),
    children: [],
  };
};

/** 片段里一个还在积累的行内段。 */
interface Run {
  readonly pieces: Piece[];
  children: HtmlNode[];
  start: number;
  paragraphCount: number;
}

/**
 * 行内段收尾：区间只到 `end` 为止；空段不产出（`<p>前<table>` 后面没有行内内容）。
 *
 * 例外是**首段**：`<p data-hr-id="p-1"><table>` 的块前面没有行内内容，但那个 `<p>` 是作者写的元素，
 * `data-hr-id` 只长在它身上。整段丢弃会让 id 无处承接、静默消失（读 `#p-1` 直接 `node_not_found`），
 * 因此把首段补成零长 span 的空 `<p>` 留住原 attrs。后续空段没有自己的 id，仍丢弃——不能凭空多出无 id 的空块。
 */
const flushRun = (run: Run, paragraph: HtmlElementNode, end: number): void => {
  if (run.children.length === 0) {
    if (
      run.paragraphCount === 0 &&
      attributeValue(paragraph.attrs, HR_ID_ATTRIBUTE) !== undefined
    ) {
      run.pieces.push({
        node: paragraphPiece(paragraph, run.start, run.start, true),
        children: [],
      });
      run.paragraphCount += 1;
    }
    return;
  }
  run.pieces.push({
    node: paragraphPiece(paragraph, run.start, end, run.paragraphCount === 0),
    children: run.children,
  });
  run.children = [];
  run.paragraphCount += 1;
};

const startOffset = (span: SourceSpan | undefined): number => span?.start ?? 0;
const endOffset = (span: SourceSpan | undefined): number => span?.end ?? 0;

/**
 * 把 `<p>` 的块级子节点挪成它的兄弟：块前面的行内内容留在原 `<p>`，块后面若还有行内内容再开一个。
 *
 * 每段的区间各自算：行内段只到**下一个块开始处**为止，因此 `hr patch <行内段 id> --action delete`
 * 不会连带切掉挪出去的块（块保留自己原有的区间与 id）。
 */
const piecesOf = (paragraph: HtmlElementNode): readonly Piece[] => {
  if (!paragraph.children.some(splitsParagraph)) {
    return [{ node: paragraph, children: paragraph.children }];
  }
  const own = paragraph.span;
  const run: Run = {
    pieces: [],
    children: [],
    start: own?.innerStart ?? 0,
    paragraphCount: 0,
  };
  for (const child of paragraph.children) {
    if (splitsParagraph(child) && child.kind === "element") {
      flushRun(run, paragraph, startOffset(child.span));
      // 被挪出的块保留它**自己的**区间与 id：它本来就有独立节点，不能跟着 `<p>` 一起被切掉。
      run.pieces.push({ node: child, children: child.children });
      run.start = endOffset(child.span);
      continue;
    }
    run.children.push(child);
  }
  flushRun(run, paragraph, endOffset(own));
  return run.pieces;
};

interface Frame {
  readonly source: readonly HtmlNode[];
  readonly out: HtmlNode[];
  cursor: number;
}

/**
 * 元素先建骨、后填子（`out` 数组在复制时就交给上层），因此深文档也不会递归爆栈。
 * 只有 `<p>` 会分裂；其余元素原样复制一层。
 */
const rebuild = (children: readonly HtmlNode[]): readonly HtmlNode[] => {
  const root: HtmlNode[] = [];
  const stack: Frame[] = [{ source: children, out: root, cursor: 0 }];
  for (const frame of drainStack(stack)) {
    for (; frame.cursor < frame.source.length; frame.cursor += 1) {
      const node = frame.source[frame.cursor];
      /* v8 ignore next */
      if (node === undefined) continue;
      if (node.kind !== "element") {
        frame.out.push(node);
        continue;
      }
      for (const piece of node.tag === "p" ? piecesOf(node) : [{ node, children: node.children }]) {
        const pieceChildren: HtmlNode[] = [];
        frame.out.push({ ...piece.node, children: pieceChildren });
        stack.push({ source: piece.children, out: pieceChildren, cursor: 0 });
      }
    }
  }
  return root;
};

/**
 * 幂等：产出里每个 `<p>` 都不再含块级子节点，因此再跑一次什么都不变（`normalize` 的第二次 `unchanged` 靠它）。
 * 只在解析后补树，不改用 parse5 的模式：quirks 判定是解析器内部状态，从外面改不了。
 * 必须跑在 `injectNodeIds` **之前**：后续分段不带 `data-hr-id`，靠注入阶段分配，否则同一篇文档里
 * 两个元素共用原 `<p>` 的 id，加载侧会自己造出 `duplicate_id`。
 */
export const closeImplicitParagraphs = (parsed: ParsedHtml): ParsedHtml => {
  if (parsed.root.kind !== "document") return parsed;
  return {
    root: { kind: "document", children: rebuild(parsed.root.children) },
    diagnostics: parsed.diagnostics,
  };
};
