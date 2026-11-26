// 这层管：排版约束子模块对外的门面（组件规约、排版检查、文档形态骨架）；不承载实现。

export { checkLayout, LAYOUT_ISSUE_LIMIT } from "./check";
export { COMPONENT_RULES } from "./components";
export type { ComponentRule } from "./components";
export { DEFAULT_DOC_KIND, DOC_KINDS, isDocKind, KIND_ATTRIBUTE, newDocumentHtml } from "./kinds";
export type { DocKind, NewDocumentInput } from "./kinds";
