// 这层管：把诊断折叠进 1024B 上限（同 code 折叠、按条数限流、只留一条截断报告）；不改报文内容。

import { type Diagnostic, DIAGNOSTIC_SEVERITY, type DiagnosticCode } from "../../html/constants";
import { OUTLINE_DIAGNOSTIC_BYTE_LIMIT, OUTLINE_DIAGNOSTIC_PER_CODE } from "./constants";

/** 同 `code` + 同 `message` 的诊断折叠成一条，`count` 保真实条数。 */
interface Entry {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly path: string | undefined;
  readonly count: number;
}

interface Selected {
  readonly list: readonly Diagnostic[];
  readonly omitted: number;
  /** 省略的诊断按 `code` 计数：只报总数看不出"哪类诊断大面积不合规"。 */
  readonly omittedByCode: ReadonlyMap<string, number>;
}

const encoder = new TextEncoder();

const bytesOf = (diagnostics: readonly Diagnostic[]): number =>
  encoder.encode(JSON.stringify(diagnostics)).length;

const keyOf = (diagnostic: Diagnostic): string =>
  [diagnostic.code, diagnostic.message].join("\u0000");

const fold = (diagnostics: readonly Diagnostic[]): readonly Entry[] => {
  const entries = new Map<string, Entry>();
  for (const diagnostic of diagnostics) {
    const key = keyOf(diagnostic);
    const existing = entries.get(key);
    entries.set(
      key,
      existing === undefined
        ? {
            code: diagnostic.code,
            message: diagnostic.message,
            path: diagnostic.path,
            count: 1,
          }
        : { ...existing, count: existing.count + 1 },
    );
  }
  return [...entries.values()];
};

const materialize = (entry: Entry): Diagnostic => {
  const message =
    entry.count > 1 ? `${entry.message}（同报文 ${String(entry.count)} 条）` : entry.message;
  return entry.path === undefined
    ? { code: entry.code, severity: DIAGNOSTIC_SEVERITY[entry.code], message }
    : { code: entry.code, severity: DIAGNOSTIC_SEVERITY[entry.code], message, path: entry.path };
};

const select = (entries: readonly Entry[], perCode: number): Selected => {
  const used = new Map<string, number>();
  const omittedByCode = new Map<string, number>();
  const list: Diagnostic[] = [];
  let omitted = 0;
  for (const entry of entries) {
    const taken = used.get(entry.code) ?? 0;
    if (taken < perCode) {
      used.set(entry.code, taken + 1);
      list.push(materialize(entry));
      continue;
    }
    omitted += entry.count;
    omittedByCode.set(entry.code, (omittedByCode.get(entry.code) ?? 0) + entry.count);
  }
  return { list, omitted, omittedByCode };
};

/** 截断报告只有一条：同时报结构/文本上限、字节预算丢了多少、以及省略了多少条诊断。 */
const truncationOf = (selected: Selected, parts: readonly string[]): Diagnostic => {
  const detail = [...selected.omittedByCode]
    .map(([code, count]) => `${code} ${String(count)} 条`)
    .join("、");
  const pieces =
    selected.omitted > 0
      ? [...parts, `另有 ${String(selected.omitted)} 条诊断省略（${detail}）`]
      : [...parts];
  return {
    code: "outline_truncated",
    severity: DIAGNOSTIC_SEVERITY.outline_truncated,
    message: pieces.join("，"),
  };
};

const withTruncation = (selected: Selected, parts: readonly string[]): readonly Diagnostic[] =>
  parts.length === 0 && selected.omitted === 0
    ? selected.list
    : [...selected.list, truncationOf(selected, parts)];

const build = (
  entries: readonly Entry[],
  perCode: number,
  parts: readonly string[],
): readonly Diagnostic[] => withTruncation(select(entries, perCode), parts);

/**
 * 三级收敛：先按 `3 条/code` 出全量；超限退到 `1 条/code`；再超限就只留截断报告。
 * 每级都会重新统计"被省略的诊断条数"，所以报文里的规模是真实值。
 */
export const fitDiagnostics = (
  base: readonly Diagnostic[],
  parts: readonly string[],
): readonly Diagnostic[] => {
  const entries = fold(base);
  const full = build(entries, OUTLINE_DIAGNOSTIC_PER_CODE, parts);
  if (bytesOf(full) <= OUTLINE_DIAGNOSTIC_BYTE_LIMIT) {
    return full;
  }
  const onePerCode = build(entries, 1, parts);
  if (bytesOf(onePerCode) <= OUTLINE_DIAGNOSTIC_BYTE_LIMIT) {
    return onePerCode;
  }
  return build(entries, 0, parts);
};
