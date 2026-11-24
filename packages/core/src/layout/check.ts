// 这层管：排版约束检查（组件结构规约 + 禁止内联 style）；只读树、只产出诊断，不改文档、不碰 IO。

import {
  COMPONENT_ATTRIBUTE,
  DIAGNOSTIC_SEVERITY,
  HR_ID_ATTRIBUTE,
  type Diagnostic,
  type DiagnosticCode,
  type HtmlElementNode,
  type HtmlNode,
} from "../html/constants";
import { joinPath, pathSegment } from "../html/path";
import { drainStack } from "../html/stack";
import { attributeOf } from "../model/attrs";
import { componentRuleOf, type ComponentRule } from "./components";

/** 诊断上限：一份满是内联样式的文档不该把回执撑到无界（与 `LINT_HIT_LIMIT` 同一思路）。 */
export const LAYOUT_ISSUE_LIMIT = 100;

/** 内联 SVG / MathML 的内部是绘图语义（`style`、`<g>` 嵌套都正常），不属于排版，不往里查。 */
const FOREIGN_TAGS: ReadonlySet<string> = new Set(["svg", "math"]);

interface Task {
  readonly node: HtmlNode;
  readonly path: string;
}

const labelOf = (node: HtmlElementNode): string => {
  const id = attributeOf(node, HR_ID_ATTRIBUTE);
  return id === undefined ? `<${node.tag}>` : `<${node.tag} ${HR_ID_ATTRIBUTE}="${id}">`;
};

const issueOf = (code: DiagnosticCode, message: string, path: string): Diagnostic => ({
  code,
  severity: DIAGNOSTIC_SEVERITY[code],
  message,
  path,
});

const childTagsOf = (node: HtmlElementNode): readonly string[] =>
  node.children.flatMap((child) => (child.kind === "element" ? [child.tag] : []));

const tagListOf = (tags: readonly string[]): string => tags.map((tag) => `<${tag}>`).join(" 或 ");

const rootIssuesOf = (
  node: HtmlElementNode,
  rule: ComponentRule,
  path: string,
): readonly Diagnostic[] =>
  rule.roots.includes(node.tag)
    ? []
    : [
        issueOf(
          "component_root",
          `组件 ${rule.name} 的根应是 ${tagListOf(rule.roots)}，现在是 ${labelOf(node)}`,
          path,
        ),
      ];

const countIssuesOf = (
  node: HtmlElementNode,
  rule: ComponentRule,
  path: string,
): readonly Diagnostic[] => {
  const [min, max] = rule.count;
  const count = childTagsOf(node).length;
  if (count >= min && count <= max) return [];
  const wanted = min === max ? `恰好 ${String(min)} 个` : ` ${String(min)}–${String(max)} 个`;
  return [
    issueOf(
      "component_shape",
      `组件 ${rule.name} 的直接子元素应为${wanted}，${labelOf(node)} 里有 ${String(count)} 个`,
      path,
    ),
  ];
};

const missingIssuesOf = (
  node: HtmlElementNode,
  rule: ComponentRule,
  path: string,
): readonly Diagnostic[] => {
  const tags = childTagsOf(node);
  return rule.requires
    .filter((group) => !group.some((tag) => tags.includes(tag)))
    .map((group) =>
      issueOf(
        "component_shape",
        `组件 ${rule.name} 缺少直接子元素 ${tagListOf(group)}：${labelOf(node)}`,
        path,
      ),
    );
};

/** 白名单外的取值由解析层报 `invalid_component`，这里不重复报。 */
const componentIssuesOf = (node: HtmlElementNode, path: string): readonly Diagnostic[] => {
  const name = attributeOf(node, COMPONENT_ATTRIBUTE);
  const rule = name === undefined ? undefined : componentRuleOf(name);
  if (rule === undefined) return [];
  return [
    ...rootIssuesOf(node, rule, path),
    ...countIssuesOf(node, rule, path),
    ...missingIssuesOf(node, rule, path),
  ];
};

const styleIssuesOf = (node: HtmlElementNode, path: string): readonly Diagnostic[] =>
  attributeOf(node, "style") === undefined
    ? []
    : [
        issueOf(
          "inline_style",
          `${labelOf(node)} 带内联 style：长相交给主题，请删掉 style 属性`,
          path,
        ),
      ];

const childrenOf = (node: HtmlNode): readonly HtmlNode[] => {
  if (node.kind === "document") return node.children;
  return node.kind === "element" && !FOREIGN_TAGS.has(node.tag) ? node.children : [];
};

/** 倒序入栈，弹出顺序才是文档序；path 与解析层诊断同一口径（父 `children` 里的原始下标）。 */
const pushChildren = (task: Task, stack: Task[]): void => {
  const children = childrenOf(task.node);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child?.kind === "element") {
      stack.push({ node: child, path: joinPath(task.path, pathSegment(child.tag, index)) });
    }
  }
};

/**
 * 入参是整棵文档树或单个片段根都可以：片段根自己的 path 记作 `<tag>[0]`。
 * 结果按文档序，最多 `LAYOUT_ISSUE_LIMIT` 条。
 */
export const checkLayout = (root: HtmlNode): readonly Diagnostic[] => {
  const issues: Diagnostic[] = [];
  const stack: Task[] = [
    { node: root, path: root.kind === "element" ? pathSegment(root.tag, 0) : "" },
  ];
  for (const task of drainStack(stack)) {
    if (task.node.kind === "element") {
      issues.push(...styleIssuesOf(task.node, task.path));
      issues.push(...componentIssuesOf(task.node, task.path));
    }
    if (issues.length >= LAYOUT_ISSUE_LIMIT) break;
    pushChildren(task, stack);
  }
  return issues.slice(0, LAYOUT_ISSUE_LIMIT);
};
