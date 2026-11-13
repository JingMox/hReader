// 这层管：结果 → 人读文本 / 单行 JSON（键序手写固定）；不做 IO、不判断退出码。
// `--json` 契约：恰好一个 `\n`、无缩进、无尾随空格；错误 JSON 也是单行。

import type {
  ApplyStyleResult,
  LintHit,
  LintReport,
  Outline,
  OutlineNode,
  PatchResult,
  ReadNodeResult,
} from "@hreader/core";

const quote = (value: string): string => JSON.stringify(value);

const bool = (value: boolean): string => (value ? "true" : "false");

export const jsonOk = (data: string): string => `{"ok":true,"data":${data}}\n`;

export const jsonError = (code: string, message: string): string =>
  `{"ok":false,"code":${quote(code)},"message":${quote(message)}}\n`;

export const dataOutline = (outline: Outline): string => JSON.stringify(outline);

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
