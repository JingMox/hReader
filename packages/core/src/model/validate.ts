// 这层管：文档级不变量校验（重复/非法 id、article 数量、标题层级）；不修数据、不碰 IO。

import {
  DIAGNOSTIC_SEVERITY,
  HR_ID_ATTRIBUTE,
  HR_ID_PATTERN,
  type Diagnostic,
  type DiagnosticCode,
  type HtmlElementNode,
  type HtmlNode,
  type ParsedHtml,
} from "../html/constants";
import { joinPath, pathSegment } from "../html/path";
import { drainStack } from "../html/stack";
import { attributeOf } from "./attrs";
import { ARTICLE_TAG, HEADING_LEVELS } from "./constants";

/**
 * 路径是节点到根的段链。注意 `enterElement` 对每个元素都拼一次路径串，
 * 所以本模块整体是 O(n·depth)（深链文档是最坏形态）。实测仍在门禁内：
 * 430KB/6000 块 4.3ms；4000 深 97.2ms（阈值 200ms）——故不为此改惰性路径。
 */
interface PathNode {
  readonly segment: string;
  readonly parent: PathNode | undefined;
}

interface Occurrence {
  readonly id: string;
  readonly path: string;
  /** 文档序位置：重复 id 的诊断要按各自的首次出现顺序落位。 */
  readonly order: number;
}

interface ArticleHit {
  readonly order: number;
  readonly path: string;
}

interface OrderedDiagnostic {
  readonly order: number;
  readonly diagnostic: Diagnostic;
}

interface Task {
  readonly kind: "enter";
  readonly node: HtmlNode;
  readonly path: PathNode;
  /** 父 `children` 里的原始下标：与解析层诊断的 `path` 同一口径。 */
  readonly childIndex: number;
}

interface State {
  readonly tasks: Task[];
  readonly occurrences: Occurrence[];
  readonly articles: ArticleHit[];
  readonly ownDiagnostics: OrderedDiagnostic[];
  lastHeading: number | undefined;
  step: number;
}

const pathToString = (node: PathNode): string => {
  const segments: string[] = [];
  let current: PathNode | undefined = node;
  while (current !== undefined) {
    // 根占位段是空串：跳过它，输出才与解析层的 `html[0]>body[1]>…` 逐字同构。
    if (current.segment !== "") {
      segments.push(current.segment);
    }
    current = current.parent;
  }
  return segments.reverse().reduce((parent, segment) => joinPath(parent, segment), "");
};

const childNodesOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "element" || node.kind === "document" ? node.children : [];

const diagnosticOf = (code: DiagnosticCode, message: string, path?: string): Diagnostic =>
  path === undefined
    ? { code, severity: DIAGNOSTIC_SEVERITY[code], message }
    : { code, severity: DIAGNOSTIC_SEVERITY[code], message, path };

const record = (state: State, code: DiagnosticCode, message: string, path: string): void => {
  state.ownDiagnostics.push({
    order: state.step,
    diagnostic: diagnosticOf(code, message, path),
  });
};

const pushChildren = (node: HtmlNode, path: PathNode, state: State): void => {
  const children = childNodesOf(node);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) {
      state.tasks.push({ kind: "enter", node: child, path, childIndex: index });
    }
  }
};

const checkId = (node: HtmlElementNode, path: string, state: State): void => {
  const id = attributeOf(node, HR_ID_ATTRIBUTE);
  if (id === undefined) {
    if (node.tag === ARTICLE_TAG) {
      record(state, "invalid_hr_id", `<${node.tag}> 缺少 data-hr-id`, path);
    }
    return;
  }
  state.occurrences.push({ id, path, order: state.step });
  if (!HR_ID_PATTERN.test(id)) {
    record(
      state,
      "invalid_hr_id",
      `data-hr-id="${id}" 不合法（应为 ${HR_ID_PATTERN.source}）`,
      path,
    );
  }
};

const checkHeading = (node: HtmlElementNode, path: string, state: State): void => {
  const level = HEADING_LEVELS[node.tag];
  if (level === undefined) {
    return;
  }
  if (state.lastHeading !== undefined && level - state.lastHeading > 1) {
    record(
      state,
      "heading_level_jump",
      `标题层级从 h${String(state.lastHeading)} 跳到 h${String(level)}（跳级 >1）`,
      path,
    );
  }
  state.lastHeading = level;
};

const enterElement = (
  node: HtmlElementNode,
  path: PathNode,
  childIndex: number,
  state: State,
): void => {
  const current: PathNode = { segment: pathSegment(node.tag, childIndex), parent: path };
  const pathText = pathToString(current);
  state.step += 1;
  if (node.tag === ARTICLE_TAG) {
    state.articles.push({ order: state.step, path: pathText });
  }
  checkId(node, pathText, state);
  checkHeading(node, pathText, state);
  pushChildren(node, current, state);
};

const enterNode = (task: Task, state: State): void => {
  if (task.node.kind === "element") {
    enterElement(task.node, task.path, task.childIndex, state);
    return;
  }
  pushChildren(task.node, task.path, state);
};

/** 重复 ID 逐条报告：先按 id 归组，再对出现 ≥2 次的组按文档序输出每一处的位置。 */
const duplicateDiagnostics = (state: State): readonly OrderedDiagnostic[] => {
  const groups = new Map<string, Occurrence[]>();
  for (const occurrence of state.occurrences) {
    const group = groups.get(occurrence.id);
    if (group === undefined) {
      groups.set(occurrence.id, [occurrence]);
    } else {
      group.push(occurrence);
    }
  }
  const result: OrderedDiagnostic[] = [];
  for (const [id, group] of groups) {
    if (group.length < 2) {
      continue;
    }
    const total = String(group.length);
    for (const occurrence of group) {
      result.push({
        order: occurrence.order,
        diagnostic: diagnosticOf(
          "duplicate_id",
          `data-hr-id="${id}" 重复出现（共 ${total} 处）`,
          occurrence.path,
        ),
      });
    }
  }
  result.sort((left, right) => left.order - right.order);
  return result;
};

const articleDiagnostics = (state: State): readonly OrderedDiagnostic[] => {
  if (state.articles.length === 1) {
    return [];
  }
  if (state.articles.length === 0) {
    return [
      {
        order: Number.POSITIVE_INFINITY,
        diagnostic: diagnosticOf("missing_article", `文档里没有 <${ARTICLE_TAG}>`),
      },
    ];
  }
  const total = String(state.articles.length);
  return state.articles.slice(1).map((article) => ({
    order: article.order,
    diagnostic: diagnosticOf(
      "multiple_article",
      `文档里有 ${total} 个 <${ARTICLE_TAG}>（应为 1 个）`,
      article.path,
    ),
  }));
};

const dedupe = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = [diagnostic.code, diagnostic.path ?? "", diagnostic.message].join("\u0000");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(diagnostic);
    }
  }
  return result;
};

/** 与 M1.1 的诊断合并：同一 code 空间，按 `code|path|message` 去重，保留首次出现的位置。 */
export const validateDocument = (parsed: ParsedHtml): readonly Diagnostic[] => {
  const state: State = {
    tasks: [
      {
        kind: "enter",
        node: parsed.root,
        path: { segment: "", parent: undefined },
        childIndex: -1,
      },
    ],
    occurrences: [],
    articles: [],
    ownDiagnostics: [],
    lastHeading: undefined,
    step: 0,
  };
  for (const task of drainStack(state.tasks)) {
    enterNode(task, state);
  }
  // 只对本模块自己的诊断做段内稳定排序；跨段顺序固定为"M1.1 诊断在前、本模块在后"。
  const derived = [
    ...state.ownDiagnostics,
    ...duplicateDiagnostics(state),
    ...articleDiagnostics(state),
  ];
  derived.sort((left, right) => left.order - right.order);
  return dedupe([...parsed.diagnostics, ...derived.map((entry) => entry.diagnostic)]);
};
