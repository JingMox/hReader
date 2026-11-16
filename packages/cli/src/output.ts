// 这层管：结果 → 人读文本 / 单行 JSON（键序手写固定）；不做 IO、不判断退出码。
// `--json` 契约：恰好一个 `\n`、无缩进、无尾随空格；错误 JSON 也是单行。

import type {
  ApplyStyleResult,
  DaemonInfo,
  ExtractStats,
  ExtractStyleLlmResult,
  ExtractStyleResult,
  HrErrorCode,
  LintHit,
  LintReport,
  Outline,
  OutlineNode,
  PatchResult,
  PendingAnnotation,
  ReadNodeResult,
  UndoResult,
} from "@hreader/core";

/** `Diagnostic` 不在 core 的公开面（`src/index.ts` 没有导出）；这里用结构类型，不强求 core 扩大导出。 */
interface DiagnosticShape {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}

/** `Dropped` 没在 core 的公开面单列；用结果类型取它，免得为了一个字段再造一个导出。 */
type DroppedItem = ExtractStyleLlmResult["dropped"][number];

const quote = (value: string): string => JSON.stringify(value);

const bool = (value: boolean): string => (value ? "true" : "false");

export const jsonOk = (data: string): string => `{"ok":true,"data":${data}}\n`;

export const jsonError = (code: HrErrorCode, message: string): string =>
  `{"ok":false,"code":${quote(code)},"message":${quote(message)}}\n`;

const nodeJson = (node: OutlineNode): string =>
  `{"id":${quote(node.id)},"tag":${quote(node.tag)},"level":${String(node.level)},` +
  `"text":${quote(node.text)},"wordCount":${String(node.wordCount)},` +
  `"children":[${node.children.map(nodeJson).join(",")}]}`;

const annotationJson = (annotation: PendingAnnotation): string =>
  `{"id":${quote(annotation.id)},"targetId":${quote(annotation.targetId)},` +
  `"comment":${quote(annotation.comment)}}`;

const diagnosticJson = (diagnostic: DiagnosticShape): string =>
  `{"code":${quote(diagnostic.code)},"severity":${quote(diagnostic.severity)},` +
  `"message":${quote(diagnostic.message)}}`;

export const dataOutline = (outline: Outline): string =>
  `{"nodes":[${outline.nodes.map(nodeJson).join(",")}],` +
  `"pendingAnnotations":[${outline.pendingAnnotations.map(annotationJson).join(",")}],` +
  `"wordCount":${String(outline.wordCount)},` +
  `"diagnostics":[${outline.diagnostics.map(diagnosticJson).join(",")}]}`;

export const dataRead = (result: ReadNodeResult, ids: readonly string[]): string =>
  `{"html":${quote(result.html)},"ids":${JSON.stringify(ids)}}`;

/** 键序 = 卡片 §3；`historyPath` 为 `null` 表示没写盘（`changed:false`）。 */
export const dataPatch = (result: PatchResult): string =>
  [
    `{"path":${quote(result.path)}`,
    `"bytes":${String(result.bytes)}`,
    `"newIds":${JSON.stringify(result.newIds)}`,
    `"changed":${bool(result.changed)}`,
    `"historyPath":${result.historyPath === null ? "null" : quote(result.historyPath)}}`,
  ].join(",");

const hitJson = (hit: LintHit): string =>
  `{"path":${quote(hit.path)},"word":${quote(hit.word)},"excerpt":${quote(hit.excerpt)},"offset":${String(hit.offset)}}`;

export const dataLint = (report: LintReport): string =>
  `{"hits":[${report.hits.map(hitJson).join(",")}]}`;

export const dataTone = (prompt: string): string => `{"prompt":${quote(prompt)}}`;

export const dataStyle = (result: ApplyStyleResult): string =>
  `{"path":${quote(result.path)},"changed":${bool(result.changed)}}`;

const statsJson = (stats: ExtractStats): string =>
  `{"paragraphs":${String(stats.paragraphs)},"sentences":${String(stats.sentences)},` +
  `"averageSentenceChars":${String(stats.averageSentenceChars)},` +
  `"maxParagraphSentences":${String(stats.maxParagraphSentences)}}`;

const droppedJson = (item: DroppedItem): string =>
  `{"field":${quote(item.field)},"reason":${quote(item.reason)}}`;

/**
 * `path` 为 `null` = 只打印没写盘；`yaml` 原样给（调用方可直接落盘或再改）。
 * `dropped` 只出现在走过 LLM 的结果上：纯统计版没有可丢的东西，凭空给空数组会暗示模型看过。
 */
export const dataStyleExtract = (
  result: ExtractStyleResult,
  path: string | null,
  dropped?: readonly DroppedItem[],
): string =>
  `{"path":${path === null ? "null" : quote(path)},"stats":${statsJson(result.stats)},"yaml":${quote(result.yaml)}` +
  (dropped === undefined ? "}" : `,"dropped":[${dropped.map(droppedJson).join(",")}]}`);

const outlineLines = (nodes: readonly OutlineNode[], depth: number): readonly string[] =>
  nodes.flatMap((node) => [
    `${"  ".repeat(depth)}- ${node.id}  ${node.text}  (${String(node.wordCount)}w)`,
    ...outlineLines(node.children, depth + 1),
  ]);

export const humanOutline = (outline: Outline): string =>
  [...outlineLines(outline.nodes, 0), ""].join("\n");

export const humanRead = (result: ReadNodeResult): string => `${result.html}\n`;

export const humanPatch = (result: PatchResult): string =>
  result.changed
    ? `patched ${result.path} (${String(result.bytes)} bytes, +${String(result.newIds.length)} ids)\n`
    : `unchanged ${result.path} (${String(result.bytes)} bytes)\n`;

export const humanLint = (report: LintReport): string =>
  [...report.hits.map((hit) => `${hit.path}: ${hit.word} — ${hit.excerpt}`), ""].join("\n");

export const humanTone = (prompt: string): string => `${prompt}\n`;

export const humanStyle = (result: ApplyStyleResult): string =>
  result.changed
    ? `styled ${result.path} (${String(result.bytes)} bytes)\n`
    : `unchanged ${result.path} (${String(result.bytes)} bytes)\n`;

/** `hr serve` 的第一行：端口与 token 一次性交给调用方（token 不落 CLI 日志）。 */
export const dataServe = (info: DaemonInfo): string =>
  `{"port":${String(info.port)},"token":${quote(info.token)},"pid":${String(info.pid)},"workspace":${quote(info.workspace)}}`;

export const humanServe = (info: DaemonInfo): string =>
  `serving ${info.workspace} on http://127.0.0.1:${String(info.port)}/ (pid ${String(info.pid)})\n`;

export const dataUndo = (result: UndoResult): string =>
  `{"path":${quote(result.path)},"bytes":${String(result.bytes)},"restoredFrom":${quote(result.restoredFrom)},"sha256":${quote(result.sha256)}}`;

export const humanUndo = (result: UndoResult): string =>
  `undone ${result.path} (${String(result.bytes)} bytes, from ${result.restoredFrom})\n`;

export const humanStyleExtract = (result: ExtractStyleResult, path: string): string =>
  `extracted ${path} (${String(result.stats.paragraphs)} 段、${String(result.stats.sentences)} 句，` +
  `平均句长 ${String(result.stats.averageSentenceChars)} 字，每段 ≤ ${String(result.stats.maxParagraphSentences)} 句)\n`;
