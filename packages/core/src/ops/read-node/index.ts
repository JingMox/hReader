// 这层管：`readNode` 编排（解析选择器 → 定位 → 外壳判定 → 剥离 → 截断 → 批注/诊断）；不解析 HTML。

import type { Diagnostic, ParsedHtml } from "../../html/constants";
import { HrError } from "../../hr-error";
import { annotationsFor, metaFieldDiagnostics } from "./annotations";
import { identifierOf } from "./attrs";
import { DEFAULT_MAX_BYTES, MAX_BYTES_LIMIT, type ReadNodeResult } from "./constants";
import { ambiguousSelector, strippedShell, truncatedOutput, withinSubtree } from "./diagnostics";
import { resolveSelector } from "./resolve";
import { parseSelector } from "./selector";
import { isForbiddenTarget, isReservedAnchorId, stripShell } from "./shell";
import { fitSubtree } from "./truncate";

export type { ReadNodeResult } from "./constants";

const isParsedHtml = (value: unknown): value is ParsedHtml => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const root: unknown = Reflect.get(value, "root");
  const diagnostics: unknown = Reflect.get(value, "diagnostics");
  return (
    typeof root === "object" &&
    root !== null &&
    typeof Reflect.get(root, "kind") === "string" &&
    Array.isArray(diagnostics)
  );
};

/** 形状不对（例如把 `injectNodeIds` 的返回值直接传进来）要报 `invalid_input`，不能炸出 `TypeError`。 */
const assertParsedHtml = (value: unknown): void => {
  if (!isParsedHtml(value)) {
    throw new HrError(
      "invalid_input",
      "第一个参数必须是 ParsedHtml（parseHtml 的返回值），不是 injectNodeIds 的结果或裸字符串",
    );
  }
};

const assertMaxBytes = (maxBytes: number): void => {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BYTES_LIMIT) {
    throw new HrError(
      "invalid_max_bytes",
      `maxBytes 必须是 (0, ${String(MAX_BYTES_LIMIT)}] 内的整数，收到 ${String(maxBytes)}`,
    );
  }
};

/** 三个阶段各自的诊断按固定顺序拼：多命中 → 剔除 → 截断 → meta 字段。 */
const ownDiagnosticsOf = (stage: {
  readonly target: string;
  readonly matches: number;
  readonly stripped: number;
  readonly fitted: { truncated: boolean; originalBytes: number; keptNodes: number };
  readonly maxBytes: number;
  readonly parsed: ParsedHtml;
}): readonly Diagnostic[] => {
  const own: Diagnostic[] = [];
  if (stage.matches > 1) {
    own.push(ambiguousSelector(stage.target, stage.matches));
  }
  if (stage.stripped > 0) {
    own.push(strippedShell(stage.stripped));
  }
  if (stage.fitted.truncated) {
    own.push(truncatedOutput(stage.fitted.originalBytes, stage.maxBytes, stage.fitted.keptNodes));
  }
  own.push(...metaFieldDiagnostics(stage.parsed));
  return own;
};

// 前置条件：`#id`/`[data-hr-id]` 需要传 `injectNodeIds(...).parsed`（裸 `parseHtml` 没有锚点）。
export const readNode = (
  parsed: ParsedHtml,
  target: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): ReadNodeResult => {
  assertParsedHtml(parsed);
  assertMaxBytes(maxBytes);
  const selector = parseSelector(target);
  if (selector.kind === "id" && isReservedAnchorId(selector.id)) {
    throw new HrError(
      "node_not_allowed",
      `目标 ${JSON.stringify(target)} 是页面外壳锚点，不可读取`,
    );
  }
  const resolved = resolveSelector(parsed.root, selector, target);
  if (isForbiddenTarget(resolved.node)) {
    throw new HrError(
      "node_not_allowed",
      `目标 ${JSON.stringify(target)} 是页面外壳或可执行容器，不可读取`,
    );
  }
  const stripped = stripShell(resolved.node);
  const fitted = fitSubtree(stripped.root, maxBytes);
  return {
    html: fitted.html,
    annotations: annotationsFor(parsed, identifierOf(resolved.node)),
    truncated: fitted.truncated,
    diagnostics: [
      ...withinSubtree(parsed.diagnostics, resolved.path),
      ...ownDiagnosticsOf({
        target,
        matches: resolved.matches,
        stripped: stripped.stripped,
        fitted,
        maxBytes,
        parsed,
      }),
    ],
  };
};
