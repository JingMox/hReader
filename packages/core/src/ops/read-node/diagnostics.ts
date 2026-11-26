// 这层管：readNode 的诊断（解析段子集 + 本层新码）；不改 ParsedHtml。

import { type Diagnostic, type DiagnosticCode, DIAGNOSTIC_SEVERITY } from "../../html/constants";

const diagnosticOf = (code: DiagnosticCode, message: string): Diagnostic => ({
  code,
  severity: DIAGNOSTIC_SEVERITY[code],
  message,
});

/**
 * 只保留落在目标子树里的解析诊断：`path` 与目标相等或以 `目标路径>` 开头。
 * 文档级诊断（无 `path`）不属于任何子树，天然被排除。
 */
export const withinSubtree = (
  diagnostics: readonly Diagnostic[],
  path: string,
): readonly Diagnostic[] =>
  diagnostics.filter(
    (diagnostic) =>
      diagnostic.path !== undefined &&
      (diagnostic.path === path || diagnostic.path.startsWith(`${path}>`)),
  );

export const ambiguousSelector = (source: string, matches: number): Diagnostic =>
  diagnosticOf(
    "ambiguous_selector",
    `选择器 ${JSON.stringify(source)} 命中 ${String(matches)} 个元素，已取文档顺序第一个`,
  );

export const strippedShell = (count: number): Diagnostic =>
  diagnosticOf("stripped_shell", `已剔除 ${String(count)} 处不可读内容（页面外壳 / 可执行容器）`);

export const truncatedOutput = (
  originalBytes: number,
  limit: number,
  keptNodes: number,
): Diagnostic =>
  diagnosticOf(
    "truncated_output",
    `（已截断：原 ${String(originalBytes)} 字节（序列化后）/ 上限 ${String(limit)} 字节 / 已保留 ${String(keptNodes)} 个节点）`,
  );
