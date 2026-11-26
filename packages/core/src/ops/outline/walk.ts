// 这层管：单趟先序遍历 `<article>`，产出 outline 草稿树与字数；不冻结、不裁字节、不读 meta。

import {
  type Diagnostic,
  DIAGNOSTIC_SEVERITY,
  type HtmlElementNode,
  type HtmlNode,
  type ParsedHtml,
} from "../../html/constants";
import { drainStack } from "../../html/stack";
import { normalizeWhitespace, textContentOf } from "../../html/text";
import { validIdOf } from "../../model/attrs";
import { HEADING_LEVELS } from "../../model/constants";
import {
  NON_VISIBLE_TEXT_TAGS,
  OUTLINE_DEPTH_LIMIT,
  OUTLINE_TAGS,
  OUTLINE_TEXT_LIMIT,
} from "./constants";
import { firstArticleOf } from "./locate";
import { countWords, truncate } from "./text";

/** 建树期间的草稿：`level` 用 -1 表示"待由首个标题决定"。 */
export interface DraftNode {
  readonly id: string;
  readonly tag: string;
  level: number;
  text: string;
  wordCount: number;
  readonly children: DraftNode[];
}

interface Frame {
  /** 缺 id 或超深度时为空：仍要开一帧，好让子树字数计到祖先上。 */
  readonly node: DraftNode | undefined;
  readonly children: DraftNode[];
  /** 容器内仍能容纳更深标题的链，按 level 递增。 */
  readonly headings: DraftNode[];
  /** 容器节点自身深度；根容器（article）记 0。 */
  readonly depth: number;
  words: number;
  levelSet: boolean;
  textSet: boolean;
  /** 子树里文档序第一个标题的 level/text（section/header 取"其所属标题层级/首个标题文本"）。 */
  firstHeadingLevel: number | undefined;
  firstHeadingText: string | undefined;
}

type Task =
  | { readonly kind: "enter"; readonly node: HtmlNode }
  | { readonly kind: "exit"; readonly frame: Frame; readonly previous: Frame };

interface WalkedArticle {
  readonly nodes: readonly DraftNode[];
  readonly wordCount: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly truncatedText: number;
  readonly truncatedDepth: number;
  /** 真实建出的节点数（供预算算真实丢弃数）。 */
  readonly builtNodes: number;
}

interface WalkState {
  current: Frame;
  readonly tasks: Task[];
  readonly diagnostics: Diagnostic[];
  truncatedText: number;
  truncatedDepth: number;
  built: number;
}

const withoutId = (node: HtmlElementNode): Diagnostic => ({
  code: "outline_node_without_id",
  severity: DIAGNOSTIC_SEVERITY.outline_node_without_id,
  message: `<${node.tag}> 缺少合法 data-hr-id，已从 outline 省略`,
});

const pushChildren = (node: HtmlNode, state: WalkState): void => {
  if (node.kind !== "element" && node.kind !== "document") {
    return;
  }
  const { children } = node;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) {
      state.tasks.push({ kind: "enter", node: child });
    }
  }
};

const takeLevelAndText = (frame: Frame, level: number, text: string): void => {
  const { node } = frame;
  if (frame.firstHeadingLevel === undefined) {
    frame.firstHeadingLevel = level;
    frame.firstHeadingText = text;
  }
  if (node === undefined) {
    return;
  }
  if (!frame.levelSet) {
    node.level = level;
    frame.levelSet = true;
  }
  if (!frame.textSet) {
    node.text = text;
    frame.textSet = true;
  }
};

/** 标题按 level 缩进在同一容器内：弹掉所有 level 不小于自己的标题后挂到最后一个更浅的标题下。 */
const attachHeading = (frame: Frame, draft: DraftNode): void => {
  for (let last = frame.headings.at(-1); last !== undefined && last.level >= draft.level;) {
    frame.headings.pop();
    last = frame.headings.at(-1);
  }
  const parent = frame.headings.at(-1);
  (parent === undefined ? frame.children : parent.children).push(draft);
  frame.headings.push(draft);
};

const enterHeading = (node: HtmlElementNode, level: number, state: WalkState): void => {
  const frame = state.current;
  const raw = normalizeWhitespace(textContentOf(node));
  const words = countWords(raw);
  frame.words += words;
  const text = truncate(raw, OUTLINE_TEXT_LIMIT);
  if (text !== raw) {
    state.truncatedText += 1;
  }
  if (validIdOf(node) === "") {
    state.diagnostics.push(withoutId(node));
    takeLevelAndText(frame, level, text);
    return;
  }
  if (frame.depth + 1 > OUTLINE_DEPTH_LIMIT) {
    state.truncatedDepth += 1;
    takeLevelAndText(frame, level, text);
    return;
  }
  const draft: DraftNode = {
    id: validIdOf(node),
    tag: node.tag,
    level,
    text,
    wordCount: words,
    children: [],
  };
  state.built += 1;
  attachHeading(frame, draft);
  takeLevelAndText(frame, level, text);
};

const enterContainer = (node: HtmlElementNode, state: WalkState): void => {
  const id = validIdOf(node);
  const depth = state.current.depth + 1;
  const overDepth = depth > OUTLINE_DEPTH_LIMIT;
  if (id === "") {
    state.diagnostics.push(withoutId(node));
  }
  if (overDepth) {
    state.truncatedDepth += 1;
  }
  const draft: DraftNode | undefined =
    id === "" || overDepth
      ? undefined
      : { id, tag: node.tag, level: -1, text: "", wordCount: 0, children: [] };
  if (draft !== undefined) {
    state.built += 1;
    state.current.children.push(draft);
  }
  const frame: Frame = {
    node: draft,
    children: draft === undefined ? [] : draft.children,
    headings: [],
    depth,
    words: 0,
    levelSet: false,
    textSet: false,
    firstHeadingLevel: undefined,
    firstHeadingText: undefined,
  };
  state.tasks.push({ kind: "exit", frame, previous: state.current });
  state.current = frame;
  pushChildren(node, state);
};

const enterNode = (node: HtmlNode, state: WalkState): void => {
  if (node.kind === "text") {
    state.current.words += countWords(node.value);
    return;
  }
  if (node.kind !== "element") {
    pushChildren(node, state);
    return;
  }
  if (NON_VISIBLE_TEXT_TAGS.has(node.tag)) {
    return;
  }
  const level = HEADING_LEVELS[node.tag];
  if (level !== undefined && level <= OUTLINE_DEPTH_LIMIT) {
    enterHeading(node, level, state);
    return;
  }
  if (OUTLINE_TAGS.has(node.tag)) {
    enterContainer(node, state);
    return;
  }
  pushChildren(node, state);
};

/** 关闭容器帧：结算子树字数、补出 section/header 的继承层级，再把字数并回父帧。 */
const closeFrame = (frame: Frame, previous: Frame, state: WalkState): void => {
  const { node } = frame;
  previous.firstHeadingLevel ??= frame.firstHeadingLevel;
  previous.firstHeadingText ??= frame.firstHeadingText;
  if (node !== undefined) {
    node.wordCount = frame.words;
    if (!frame.levelSet) {
      const inherited =
        previous.node === undefined || previous.node.level < 0 ? 0 : previous.node.level;
      node.level = frame.firstHeadingLevel ?? inherited;
    }
    if (!frame.textSet) {
      node.text = frame.firstHeadingText ?? "";
    }
  }
  previous.words += frame.words;
  state.current = previous;
};

const rootFrameOf = (): Frame => ({
  node: undefined,
  children: [],
  headings: [],
  depth: 0,
  words: 0,
  levelSet: false,
  textSet: false,
  firstHeadingLevel: undefined,
  firstHeadingText: undefined,
});

const emptyWalk = (): WalkedArticle => ({
  nodes: [],
  wordCount: 0,
  diagnostics: [],
  truncatedText: 0,
  truncatedDepth: 0,
  builtNodes: 0,
});

export const walkArticle = (parsed: ParsedHtml): WalkedArticle => {
  const article = firstArticleOf(parsed.root);
  if (article === undefined) {
    return emptyWalk();
  }
  const root: Frame = rootFrameOf();
  const state: WalkState = {
    current: root,
    tasks: [],
    diagnostics: [],
    truncatedText: 0,
    truncatedDepth: 0,
    built: 0,
  };
  pushChildren(article, state);
  for (const task of drainStack(state.tasks)) {
    if (task.kind === "exit") {
      closeFrame(task.frame, task.previous, state);
      continue;
    }
    enterNode(task.node, state);
  }
  return {
    nodes: root.children,
    wordCount: root.words,
    diagnostics: state.diagnostics,
    truncatedText: state.truncatedText,
    truncatedDepth: state.truncatedDepth,
    builtNodes: state.built,
  };
};
