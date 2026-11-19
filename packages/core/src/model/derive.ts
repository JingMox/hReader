// 这层管：把 ParsedHtml 投影成只读 DocumentModel（单趟先序、收尾冻结）；不二次解析、不改入参。

import { HrError } from "../hr-error";
import { type HtmlElementNode, type HtmlNode, type ParsedHtml } from "../html/constants";
import { drainStack } from "../html/stack";
import { normalizeWhitespace } from "../html/text";
import { ARTICLE_TAG, BR_TAG, type DocumentModel } from "./constants";
import { componentOf, isBlockElement, validIdOf } from "./attrs";

interface Draft {
  readonly id: string;
  readonly tag: string;
  readonly component: string | undefined;
  /** 按文档序累积的原始文本片段，收尾时一次归一。 */
  readonly textPieces: string[];
  /** 子节点收尾（冻结）后回填，因此这里拿到的都是成品。 */
  readonly children: DocumentModel[];
}

type Task =
  | { readonly kind: "enter"; readonly node: HtmlNode }
  | { readonly kind: "exit"; readonly draft: Draft };

interface DeriveState {
  readonly tasks: Task[];
  /** 已进入但未收尾的块级祖先；栈顶即当前文本的归属节点。 */
  readonly open: Draft[];
  root: DocumentModel | undefined;
  articles: number;
}

const freezeDraft = (draft: Draft): DocumentModel => {
  const text = normalizeWhitespace(draft.textPieces.join(""));
  if (draft.component === undefined) {
    return Object.freeze({
      id: draft.id,
      tag: draft.tag,
      text,
      children: Object.freeze(draft.children),
    });
  }
  return Object.freeze({
    id: draft.id,
    tag: draft.tag,
    component: draft.component,
    text,
    children: Object.freeze(draft.children),
  });
};

const draftOf = (node: HtmlElementNode, tag: string): Draft => ({
  id: validIdOf(node),
  tag,
  component: componentOf(node),
  textPieces: [],
  children: [],
});

const childNodesOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "element" || node.kind === "document" ? node.children : [];

const pushChildren = (node: HtmlNode, state: DeriveState): void => {
  const children = childNodesOf(node);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) {
      state.tasks.push({ kind: "enter", node: child });
    }
  }
};

const enterArticle = (node: HtmlElementNode, state: DeriveState): void => {
  state.articles += 1;
  if (state.articles > 1) {
    throw new HrError(
      "invalid_document",
      `文档里有多个 <${ARTICLE_TAG}>：模型只能有 1 个顶层 article`,
    );
  }
  const draft = draftOf(node, ARTICLE_TAG);
  if (draft.id === "") {
    // 不点名 `injectNodeIds`：那是内部函数，用户手上没有这个入口（B-02）。
    throw new HrError(
      "needs_normalize",
      `<${ARTICLE_TAG}> 缺少合法的 data-hr-id：这份文档还没 normalize 过（先跑 hr normalize --write）`,
    );
  }
  state.open.push(draft);
  state.tasks.push({ kind: "exit", draft });
  pushChildren(node, state);
};

/** 块级子树的边界在渲染上是换行：给父节点的文本补一个空格，避免 "lo"+"hi" 粘成 "lohi"。 */
const separateBlock = (owner: Draft): void => {
  owner.textPieces.push(" ");
};

const enterElement = (node: HtmlElementNode, state: DeriveState): void => {
  if (node.tag === ARTICLE_TAG) {
    enterArticle(node, state);
    return;
  }
  const owner = state.open.at(-1);
  if (node.tag === BR_TAG) {
    if (owner !== undefined) {
      separateBlock(owner);
    }
    return;
  }
  if (!isBlockElement(node) || owner === undefined) {
    pushChildren(node, state);
    return;
  }
  separateBlock(owner);
  const draft = draftOf(node, node.tag);
  if (draft.id !== "") {
    state.open.push(draft);
    state.tasks.push({ kind: "exit", draft });
  }
  pushChildren(node, state);
};

const enterNode = (node: HtmlNode, state: DeriveState): void => {
  if (node.kind === "element") {
    enterElement(node, state);
    return;
  }
  const owner = state.open.at(-1);
  if (node.kind === "text" && owner !== undefined) {
    owner.textPieces.push(node.value);
    return;
  }
  pushChildren(node, state);
};

const exitDraft = (draft: Draft, state: DeriveState): void => {
  state.open.pop();
  const model = freezeDraft(draft);
  const parent = state.open.at(-1);
  if (parent === undefined) {
    state.root = model;
    return;
  }
  parent.children.push(model);
};

/**
 * 单趟先序遍历 + 显式栈：深度只影响栈长度，不会爆调用栈。
 * 文本节点一律归到最近的未收尾块级祖先（块级后代自成节点，天然被隔开）。
 */
export const toDocumentModel = (parsed: ParsedHtml): DocumentModel => {
  const state: DeriveState = {
    tasks: [{ kind: "enter", node: parsed.root }],
    open: [],
    root: undefined,
    articles: 0,
  };
  for (const task of drainStack(state.tasks)) {
    if (task.kind === "exit") {
      exitDraft(task.draft, state);
      continue;
    }
    enterNode(task.node, state);
  }
  if (state.root === undefined) {
    throw new HrError("invalid_document", `文档里没有 <${ARTICLE_TAG}>：无法派生文档模型`);
  }
  return state.root;
};
