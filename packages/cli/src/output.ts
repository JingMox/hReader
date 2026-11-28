// This layer: result -> human-readable text / single-line JSON (key order hand-pinned); no IO, no exit codes.
// `--json` contract: exactly one `\n`, no indent, no trailing space; error JSON is single-line too.

import { relative, sep } from "node:path";

import type { PrintHtmlResult } from "@hreader/renderer-html";
import { cutAtCodePoint } from "@hreader/core";
import type {
  ApplyStyleResult,
  DaemonInfo,
  DocAnnotationEntry,
  DocMetaRecord,
  ExtractStats,
  ExtractStyleLlmResult,
  ExtractStyleResult,
  HrErrorCode,
  HrErrorData,
  ImportDiscard,
  ImportReport,
  LibrarySearchResult,
  LintHit,
  LintReport,
  LoadedTemplate,
  MigrateResult,
  Outline,
  OutlineNode,
  NormalizeResult,
  PatchResult,
  PendingAnnotation,
  ReadNodeResult,
  RelocateResult,
  SavedTemplate,
  SearchHit,
  TemplateDiagnostic,
  TemplateList,
  TemplateSummary,
  UndoResult,
} from "@hreader/core";

/** `Diagnostic` is not on core's public surface (not exported by `src/index.ts`); a structural type is used here rather than widening core's exports. */
interface DiagnosticShape {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
}

/** `Dropped` is not listed on core's public surface either; it is taken from the result type rather than minting an export for one field. */
type DroppedItem = ExtractStyleLlmResult["dropped"][number];

const quote = (value: string): string => JSON.stringify(value);

/**
 * Terminal sanitization for human receipts: titles, file names, and diagnostic bodies come from untrusted
 * documents and disk, and written verbatim they can color, move the cursor, hang fake OSC 8 links, or flip
 * display via bidi.
 * Strip whole CSI/OSC sequences first, then clear leftover C0/C1/DEL and bidi override marks; \n and \t are
 * the receipt's own layout (not injection vectors) and stay.
 * `--json` does not go through here: `JSON.stringify` already escapes per character — stripping would alter data.
 * Document products (`humanExport`'s html, `humanTone`'s prompt) skip it too: they are byte contracts meant to be redirected to disk.
 */
/* eslint-disable no-control-regex -- these three patterns match control characters on purpose: strip CSI/OSC sequences, clear leftover C0/C1/DEL. */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex -- control-character matching ends here. */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

export const term = (text: string): string =>
  text.replace(OSC, "").replace(CSI, "").replace(CONTROL, "").replace(BIDI, "");

/** Per-write character cap for stderr: error text echoes unbounded input verbatim (giant selectors, huge
 * paths), and an MB-scale single line can stall the terminal and log pipelines. Applies only to the stderr
 * diagnostics channel — stdout is a byte contract (reports, envelopes, document products) and nothing is ever truncated. */
const STDERR_MAX_CHARS = 8 * 1024;

export const bounded = (text: string): string => {
  if (text.length <= STDERR_MAX_CHARS) return text;
  const kept = cutAtCodePoint(text, STDERR_MAX_CHARS);
  return `${kept}…[truncated ${String(text.length - kept.length)} chars]`;
};

/**
 * Receipt paths always echo from the user's view: a document inside cwd prints relative to cwd (that is how
 * the user typed it); only outside cwd (or cwd itself) does the absolute path print. The command layer only
 * knows workspace-relative names and `--out` only knows realpaths, so "the string the user gave" can only be
 * computed by the dispatch layer (`run.ts`) and passed in; every path-printing receipt must share this convention.
 */
export const displayedPathOf = (path: string, cwd: string): string => {
  const rel = relative(cwd, path);
  // Escaping cwd means `..` or `..<sep>…`; `..foo` is a normal path whose name starts with two dots and must not be misjudged as outside.
  return rel === "" || rel === ".." || rel.startsWith(".." + sep) ? path : rel;
};

const bool = (value: boolean): string => (value ? "true" : "false");

export const jsonOk = (data: string): string => `{"ok":true,"data":${data}}\n`;

/** `data` is the machine-readable cause for caller branches (e.g. `invalid_selector`'s `reason`/`candidates`); the whole key is absent when there is none. */
export const jsonError = (code: HrErrorCode, message: string, data?: HrErrorData): string =>
  `{"ok":false,"code":${quote(code)},"message":${quote(message)}` +
  `${data === undefined ? "" : `,"data":${JSON.stringify(data)}`}}\n`;

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

/** Keys always present (`false`/`[]` when not truncated): the `--json` contract only grows — conditional keys
 * would push a "key may be absent" branch onto every caller; a stable shape costs just one `false`. */
export const dataRead = (result: ReadNodeResult, ids: readonly string[]): string =>
  `{"html":${quote(result.html)},"ids":${JSON.stringify(ids)},` +
  `"truncated":${bool(result.truncated)},` +
  `"diagnostics":[${result.diagnostics.map(diagnosticJson).join(",")}]}`;

/** Key order is pinned (public contract); `historyPath` is `null` when nothing was written (`changed:false`).
 * `replacedIds` appears only when `replace` actually changed the target id: other actions print no empty array,
 * lest existing callers think a "mapping" exists.
 * `warnings` likewise appears only when non-empty (parse diagnostics like the fragment's `duplicate_attribute`).
 */
export const dataPatch = (result: PatchResult): string =>
  [
    `{"path":${quote(result.path)}`,
    `"bytes":${String(result.bytes)}`,
    `"newIds":${JSON.stringify(result.newIds)}`,
    `"changed":${bool(result.changed)}`,
    `"historyPath":${result.historyPath === null ? "null" : quote(result.historyPath)}`,
    ...(result.replacedIds.length === 0
      ? []
      : [`"replacedIds":${JSON.stringify(result.replacedIds)}`]),
    ...(result.warnings === undefined || result.warnings.length === 0
      ? []
      : [`"warnings":[${result.warnings.map(diagnosticJson).join(",")}]`]),
  ].join(",") + "}";

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
 * `path` is `null` = printed only, nothing written; `yaml` is given verbatim (the caller can write or edit it).
 * `dropped` appears only on LLM-backed results: the stats-only path has nothing to drop, and an empty array would imply a model looked.
 */
export const dataStyleExtract = (
  result: ExtractStyleResult,
  path: string | null,
  dropped?: readonly DroppedItem[],
): string =>
  `{"path":${path === null ? "null" : quote(path)},"stats":${statsJson(result.stats)},"yaml":${quote(result.yaml)}` +
  (dropped === undefined ? "}" : `,"dropped":[${dropped.map(droppedJson).join(",")}]}`);

/** `out` is `null` = printed to stdout only; `bytes` equals the written file's size (re-checked via `statSync`). */
export const dataExport = (report: PrintHtmlResult, out: string | null): string =>
  `{"html":${quote(report.html)},"bytes":${String(report.bytes)},` +
  `"droppedImages":${String(report.droppedImages)},"out":${out === null ? "null" : quote(out)}}`;

export const humanExport = (report: PrintHtmlResult): string => report.html;

export const humanExportWritten = (out: string, bytes: number): string =>
  term(`exported ${out} (${String(bytes)} bytes)\n`);

/** `pdf` is the product's base64: `--json` gives all bytes or none (same trade-off as `dataExport`'s `html`).
 * `outline` is the **outline entry count in the product** (read from the PDF `/Outlines` tree): 0 under `--no-outline` or with no headings. */
export interface PdfReport {
  readonly base64: string;
  readonly bytes: number;
  readonly pages: number;
  readonly outline: number;
  readonly out: string;
}

export const dataPdf = (report: PdfReport): string =>
  `{"pdf":${quote(report.base64)},"bytes":${String(report.bytes)},"pages":${String(report.pages)},` +
  `"outline":${String(report.outline)},"out":${quote(report.out)}}`;

export const humanPdf = (report: PdfReport, path: string = report.out): string =>
  term(`${path} (${String(report.pages)} 页, ${String(report.outline)} 条书签)\n`);

/** `png` follows `pdf`'s trade-off: `--json` carries the whole image's base64; `width`/`height` are device
 * pixels read back from IHDR (`--scale` already multiplied in — not the same unit as the CSS pixels of
 * `--width`/`--max-height`, do not compare directly). */
export interface PngReport {
  readonly base64: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly clipped: boolean;
  readonly out: string;
}

export const dataPng = (report: PngReport): string =>
  `{"png":${quote(report.base64)},"bytes":${String(report.bytes)},"width":${String(report.width)},"height":${String(report.height)},"clipped":${String(report.clipped)},"out":${quote(report.out)}}`;

export const humanPng = (report: PngReport, path: string = report.out): string =>
  term(
    `exported ${path} (${String(report.bytes)} bytes, ${String(report.width)}×${String(report.height)}${report.clipped ? ", clipped" : ""})\n`,
  );

const outlineLines = (nodes: readonly OutlineNode[], depth: number): readonly string[] =>
  nodes.flatMap((node) => [
    `${"  ".repeat(depth)}- ${term(node.id)}  ${term(node.text)}  (${String(node.wordCount)}w)`,
    ...outlineLines(node.children, depth + 1),
  ]);

/** An empty outline cannot be silent: 0-byte stdout + exit 0 reads as "document is fine" when it is really "no headings at all".
 * The second line names the next move: a heading-less document (paper body, Word export) can only be navigated by content, and `read` is that path.
 * The path default is a placeholder for unit tests calling this directly; the CLI always passes the user's-view path.
 */
export const humanOutline = (outline: Outline, displayPath = "<文件>"): string =>
  outline.nodes.length === 0
    ? term(`（没有标题）\n本文没有标题；用 hr read ${displayPath} <nodeId|selector> 取内容\n`)
    : [...outlineLines(outline.nodes, 0), ""].join("\n");

/** Diagnostics line in human mode: same source as `--json`'s `diagnostics`, just compressed to one line. */
export const humanDiagnostic = (diagnostic: DiagnosticShape): string =>
  term(`${diagnostic.severity}: ${diagnostic.message}\n`);

/** Truncation cannot live only in JSON `diagnostics`: human-mode stdout would be identical to the untruncated case, and the user would just think the node is that short.
 * It prints core's `truncated_output` text verbatim (no second set of numbers): one source for both outputs, so they cannot disagree.
 */
export const humanRead = (result: ReadNodeResult): string => {
  const truncation = result.diagnostics.find((item) => item.code === "truncated_output");
  return `${result.html}\n${truncation === undefined ? "" : `${term(truncation.message)}\n`}`;
};

/**
 * `replace` re-issues ids by content: unless the "old id -> new id" mapping is printed, the old id in the user's hand stops working.
 * Incidental new ids outside the mapping (deeper blocks in the fragment) still follow behind; with no new ids no empty list prints — a noise tail on every line.
 */
export const humanPatch = (result: PatchResult, path: string = result.path): string => {
  // The fragment's parse diagnostics print with the receipt: it was written, but something is missing from the bytes — the user must see it.
  const warnings = (result.warnings ?? [])
    .map((diagnostic) => `warning: ${diagnostic.code} — ${diagnostic.message}\n`)
    .join("");
  if (!result.changed) {
    return term(`unchanged ${path} (${String(result.bytes)} bytes)\n${warnings}`);
  }
  const replaced = result.replacedIds;
  if (replaced.length === 0) {
    const ids = result.newIds.length === 0 ? "" : ` ids: ${result.newIds.join(", ")}`;
    return term(
      `patched ${path} (${String(result.bytes)} bytes, +${String(result.newIds.length)}${ids})\n${warnings}`,
    );
  }
  const mapped = new Set(replaced.map((pair) => pair.to));
  const extras = result.newIds.filter((id) => !mapped.has(id));
  const extraText =
    extras.length === 0 ? "" : `, +${String(extras.length)} ids: ${extras.join(", ")}`;
  const pairs = replaced.map((pair) => `${pair.from} → ${pair.to}`).join(", ");
  return term(
    `patched ${path} (${String(result.bytes)} bytes, id 变更: ${pairs}${extraText})\n${warnings}`,
  );
};

export const humanLint = (report: LintReport): string =>
  term(
    [
      ...report.hits.map(
        (hit) => `${hit.path}:${String(hit.offset)}: ${hit.word} — ${hit.excerpt}`,
      ),
      "",
    ].join("\n"),
  );

export const humanTone = (prompt: string): string => `${prompt}\n`;

export const humanStyle = (result: ApplyStyleResult, path: string = result.path): string =>
  result.changed
    ? term(`styled ${path} (${String(result.bytes)} bytes)\n`)
    : term(
        `unchanged ${path} (${String(result.bytes)} bytes，主题已与文档里的 <style id="hr-theme"> 一致)\n`,
      );

/** A URL the user can paste straight into a browser: first visit carries a valid token, the server sets the cookie and 302s back to a clean `/`. */
export const serveUrlOf = (info: DaemonInfo): string =>
  `http://127.0.0.1:${String(info.port)}/?token=${encodeURIComponent(info.token)}`;

/** `hr serve`'s first line: port, token, and a directly openable URL handed to the caller in one go (the token never reaches CLI logs). */
export const dataServe = (info: DaemonInfo): string =>
  `{"port":${String(info.port)},"token":${quote(info.token)},"url":${quote(serveUrlOf(info))},` +
  `"pid":${String(info.pid)},"workspace":${quote(info.workspace)}}`;

export const humanServe = (info: DaemonInfo, path: string = info.workspace): string =>
  term(`serving ${path} on ${serveUrlOf(info)} (pid ${String(info.pid)})\n`);

export const dataUndo = (result: UndoResult): string =>
  jsonOk(
    `{"path":${quote(result.path)},"bytes":${String(result.bytes)},"restoredFrom":${quote(result.restoredFrom)},"sha256":${quote(result.sha256)}}`,
  );

export const humanUndo = (result: UndoResult, path: string = result.path): string =>
  term(`undone ${path} (${String(result.bytes)} bytes, from ${result.restoredFrom})\n`);

/** `html` enters the JSON verbatim: the caller can byte-compare it against disk/`--out` directly. */
export const dataNormalize = (result: NormalizeResult): string =>
  `{"needsNormalize":${bool(result.needsNormalize)},"html":${quote(result.html)},"injected":${String(result.injected)}}`;

export const humanNormalizeWritten = (
  result: NormalizeResult,
  path: string = result.path,
): string =>
  result.changed
    ? term(`normalized ${path} (+${String(result.injected)} ids, ${String(result.bytes)} bytes)\n`)
    : term(`unchanged ${path} (${String(result.bytes)} bytes，已带齐 data-hr-id)\n`);

export const humanStyleExtract = (result: ExtractStyleResult, path: string): string =>
  term(
    `extracted ${path} (${String(result.stats.paragraphs)} 段、${String(result.stats.sentences)} 句，` +
      `平均句长 ${String(result.stats.averageSentenceChars)} 字，每段 ≤ ${String(result.stats.maxParagraphSentences)} 句)\n`,
  );

/** `Diagnostic` is not on core's public surface beyond `path`; a structural type is used here, same trade-off as `DiagnosticShape`. */
interface IssueShape {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly path?: string;
}

interface NewDocReport {
  readonly path: string;
  readonly kind: string;
  readonly title: string;
  readonly bytes: number;
}

/** `path` is always present (`null` when nothing was located): the `--json` shape does not vary by diagnostic kind. */
const issueJson = (issue: IssueShape): string =>
  JSON.stringify({
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    path: issue.path ?? null,
  });

/** `cls` is the additive field for the three-way foreign-HTML classification; `reason` is only given for `foreign` (a human-readable cause). */
export const dataCheck = (issues: readonly IssueShape[], cls: string, reason?: string): string =>
  `{"issues":[${issues.map(issueJson).join(",")}],"count":${String(issues.length)},` +
  `"cls":${quote(cls)}${reason === undefined ? "" : `,"reason":${quote(reason)}`}}`;

const issueLine = (issue: IssueShape): string =>
  term(
    `${issue.severity}: ${issue.code} — ${issue.message}${issue.path === undefined ? "" : ` @ ${issue.path}`}\n`,
  );

/** Explanatory line for foreign documents: follows the diagnostics, telling the user "readable, but not block-editable". */
const FOREIGN_NOTE = "外来 HTML 文档：hReader 会以只读方式打开，不支持按块编辑\n";

/** Even a clean result needs a line: 0-byte stdout reads like "never ran". */
export const humanCheck = (issues: readonly IssueShape[], path: string, foreign = false): string =>
  (issues.length === 0
    ? term(`ok ${path}（没有排版问题）\n`)
    : `${issues.map(issueLine).join("")}${term(`${path}：${String(issues.length)} 条问题\n`)}`) +
  (foreign ? FOREIGN_NOTE : "");

export const dataNew = (report: NewDocReport): string =>
  JSON.stringify({
    path: report.path,
    kind: report.kind,
    title: report.title,
    bytes: report.bytes,
  });

export const humanNew = (report: NewDocReport, path: string): string =>
  term(`created ${path} (${report.kind}, ${String(report.bytes)} bytes)\n`);

const discardJson = (item: ImportDiscard): string =>
  `{"what":${quote(item.what)},"reason":${quote(item.reason)},"count":${String(item.count)}}`;

/** Key order is pinned (public contract); `trunkTag` only has a value for largest, `null` otherwise — the `--json` shape does not vary with trunk source. */
export const dataImport = (path: string, bytes: number, report: ImportReport): string =>
  `{"path":${quote(path)},"bytes":${String(bytes)},"kind":${quote(report.kind)},` +
  `"title":${quote(report.title)},"titleSource":${quote(report.titleSource)},` +
  `"trunk":${quote(report.trunk)},"trunkTag":${report.trunkTag === undefined ? "null" : quote(report.trunkTag)},` +
  `"sections":${String(report.sections)},"removedElements":${String(report.removedElements)},` +
  `"strippedAttributes":${String(report.strippedAttributes)},` +
  `"discarded":[${report.discarded.map(discardJson).join(",")}]}`;

const TITLE_SOURCE_LABEL: Readonly<Record<ImportReport["titleSource"], string>> = {
  option: "--title",
  title: "<title>",
  h1: "首个 <h1>",
  fallback: "兜底文案",
};

/** Human-readable report summary: product line + title/trunk/stripped-count line + drop details (that section is absent when nothing was dropped). */
export const humanImport = (report: ImportReport, out: string, bytes: number): string => {
  // trunkTag only has a value for largest (report contract): using it as the largest check avoids evaluating undefined.
  const trunk =
    report.trunkTag !== undefined
      ? `<${report.trunkTag}>`
      : report.trunk === "main"
        ? "<main>"
        : "<body>";
  const dropped = report.discarded
    .map((item) => `\n    ${item.what} ×${String(item.count)}（${item.reason}）`)
    .join("");
  return term(
    `imported ${out} (${report.kind}, ${String(report.sections)} 节, ${String(bytes)} bytes)\n` +
      `  标题「${report.title}」（${TITLE_SOURCE_LABEL[report.titleSource]}）；主干：${trunk}；` +
      `剥除元素 ${String(report.removedElements)} 个、属性 ${String(report.strippedAttributes)} 个` +
      `${dropped === "" ? "" : `\n  丢弃明细：${dropped}`}\n`,
  );
};

// ---- template commands (`hr template <list|show|new|save>`) ----

const templateSummaryJson = (summary: TemplateSummary): string =>
  JSON.stringify({
    id: summary.id,
    name: summary.name,
    description: summary.description,
    format: summary.format,
    tags: summary.tags,
    source: summary.source,
  });

const templateDiagnosticJson = (diagnostic: TemplateDiagnostic): string =>
  JSON.stringify({
    id: diagnostic.id,
    source: diagnostic.source,
    message: diagnostic.message,
  });

export const dataTemplateList = (list: TemplateList): string =>
  `{"templates":[${list.templates.map(templateSummaryJson).join(",")}],` +
  `"diagnostics":[${list.diagnostics.map(templateDiagnosticJson).join(",")}]}`;

/** Long free-text cells (name/tags) are capped so one row stays one line in the human table. */
const TABLE_CELL_LIMIT = 40;

const tableCell = (text: string): string => {
  const clean = term(text);
  return Array.from(clean).length > TABLE_CELL_LIMIT
    ? `${cutAtCodePoint(clean, TABLE_CELL_LIMIT)}…`
    : clean;
};

export const humanTemplateList = (templates: readonly TemplateSummary[]): string => {
  type Row = [id: string, name: string, format: string, source: string, tags: string];
  const rows: Row[] = [
    ["id", "name", "format", "source", "tags"],
    ...templates.map((summary): Row => [
      tableCell(summary.id),
      tableCell(summary.name),
      tableCell(summary.format),
      tableCell(summary.source),
      tableCell(summary.tags.join(",")),
    ]),
  ];
  const width = (index: 0 | 1 | 2 | 3): number => Math.max(...rows.map((row) => row[index].length));
  const widths: [number, number, number, number] = [width(0), width(1), width(2), width(3)];
  return `${rows
    .map(
      ([id, name, format, source, tags]) =>
        `${id.padEnd(widths[0])}  ${name.padEnd(widths[1])}  ` +
        `${format.padEnd(widths[2])}  ${source.padEnd(widths[3])}  ${tags}`,
    )
    .join("\n")}\n`;
};

/** Byte sizes of the text members, computed at the command layer (UTF-8 counts, matching what `read` reports). */
export interface TemplateSizes {
  readonly entry: number;
  readonly style?: number;
  readonly guide?: number;
}

const memberSizeLine = (label: string, bytes: number | undefined): string =>
  `${label}: ${bytes === undefined ? "（无）" : `${String(bytes)} bytes`}`;

/** `assets` lists at most the first few lines verbatim; a long tail collapses into a count (the --json form has them all). */
const ASSET_LIST_LIMIT = 50;

/** The guide body is content (like `hr read`'s html): it prints verbatim, not through `term` — fields above are sanitized. */
export const humanTemplateShow = (loaded: LoadedTemplate, sizes: TemplateSizes): string => {
  const manifest = loaded.manifest;
  const assetLines =
    loaded.assets.length <= ASSET_LIST_LIMIT
      ? loaded.assets
      : [...loaded.assets.slice(0, ASSET_LIST_LIMIT), `…（共 ${String(loaded.assets.length)} 个）`];
  const head = [
    `id: ${term(manifest.id)}`,
    `name: ${term(manifest.name)}`,
    `description: ${term(manifest.description)}`,
    `version: ${String(manifest.version)}`,
    `format: ${manifest.format}`,
    `source: ${loaded.source}`,
    `tags: ${term(manifest.tags.join(", ") || "-")}`,
    memberSizeLine("entry", sizes.entry),
    memberSizeLine("style", sizes.style),
    memberSizeLine("guide", sizes.guide),
    `assets: ${String(loaded.assets.length)} 个`,
    ...assetLines.map((asset) => `  ${term(asset)}`),
  ].join("\n");
  const body =
    loaded.guide === undefined
      ? ""
      : `\n--- guide.md ---\n${loaded.guide}${loaded.guide.endsWith("\n") ? "" : "\n"}`;
  return `${head}\n${body}`;
};

/** `style`/`guide` print `null` when absent (stable shape); `manifest` keeps authored keys (absent optionals stay absent). */
export const dataTemplateShow = (loaded: LoadedTemplate): string =>
  `{"manifest":${JSON.stringify(loaded.manifest)},"source":${quote(loaded.source)},` +
  `"entry":${quote(loaded.entry)},` +
  `"style":${loaded.style === undefined ? "null" : quote(loaded.style)},` +
  `"guide":${loaded.guide === undefined ? "null" : quote(loaded.guide)},` +
  `"assets":${JSON.stringify(loaded.assets)}}`;

export interface TemplateNewReport {
  readonly path: string;
  readonly template: string;
  /** `null` = the template's own title was kept (nothing was overridden). */
  readonly title: string | null;
  readonly bytes: number;
  readonly assets: readonly string[];
}

export const dataTemplateNew = (report: TemplateNewReport): string =>
  `{"path":${quote(report.path)},"template":${quote(report.template)},` +
  `"title":${report.title === null ? "null" : quote(report.title)},"bytes":${String(report.bytes)},` +
  `"assets":${JSON.stringify(report.assets)}}`;

export const humanTemplateNew = (report: TemplateNewReport, path: string): string =>
  term(
    `created ${path} (${report.template}, ${String(report.bytes)} bytes` +
      `${report.assets.length === 0 ? "" : `, +${String(report.assets.length)} assets`})\n`,
  );

export const dataTemplateSave = (saved: SavedTemplate): string =>
  `{"id":${quote(saved.id)},"dir":${quote(saved.dir)},"format":${quote(saved.format)},` +
  `"scope":${quote(saved.scope)},"assets":${JSON.stringify(saved.assets)}}`;

export const humanTemplateSave = (saved: SavedTemplate, dir: string): string =>
  term(
    `saved ${dir} (${saved.id}, ${saved.format}` +
      `${saved.assets.length === 0 ? "" : `, +${String(saved.assets.length)} assets`})\n`,
  );

// ---- annotations commands (`hr annotations <list|migrate>`) ----

/** Same wire shape as the server's `relocationBody`: `via` only rides on success. */
const relocationJson = (relocation: RelocateResult): string =>
  relocation.ok
    ? `{"ok":true,"start":${String(relocation.start)},"end":${String(relocation.end)},` +
      `"via":${quote(relocation.via)}}`
    : `{"ok":false,"reason":${quote(relocation.reason)}}`;

/** `id`/`nodeId`/`selector`/`exact` are unbounded at the model layer: same 200-code-point cap as the MCP wire, so a fat record cannot flood either output mode. */
const ANNOTATION_FIELD_LIMIT = 200;

/** `nodeId`/`selector` print `null` when absent (stable shape): a merged entry knows at most one of them. */
const annotationEntryJson = (entry: DocAnnotationEntry): string =>
  `{"id":${quote(cutAtCodePoint(entry.annotation.id, ANNOTATION_FIELD_LIMIT))},` +
  `"nodeId":${entry.annotation.nodeId === undefined ? "null" : quote(cutAtCodePoint(entry.annotation.nodeId, ANNOTATION_FIELD_LIMIT))},` +
  `"selector":${entry.annotation.selector === undefined ? "null" : quote(cutAtCodePoint(entry.annotation.selector, ANNOTATION_FIELD_LIMIT))},` +
  `"note":${quote(entry.annotation.note)},` +
  `"exact":${quote(cutAtCodePoint(entry.annotation.anchor.exact, ANNOTATION_FIELD_LIMIT))},` +
  `"status":${quote(entry.annotation.status)},` +
  `"source":${quote(entry.source)},` +
  `"relocation":${relocationJson(entry.anchor)}}`;

export const dataAnnotationsList = (
  path: string,
  annotations: readonly DocAnnotationEntry[],
  diagnostics: readonly string[],
): string =>
  `{"path":${quote(path)},"annotations":[${annotations.map(annotationEntryJson).join(",")}],` +
  `"diagnostics":${JSON.stringify(diagnostics)}}`;

/** One annotation per line; note first, the anchored text as the fallback excerpt. `-` = the record carries neither nodeId nor selector. */
const annotationLine = (entry: DocAnnotationEntry): string => {
  const annotation = entry.annotation;
  const target = annotation.nodeId ?? annotation.selector ?? "-";
  const excerpt = tableCell(annotation.note === "" ? annotation.anchor.exact : annotation.note);
  const located = entry.anchor.ok
    ? `已定位（${entry.anchor.via}，${String(entry.anchor.start)}-${String(entry.anchor.end)}）`
    : `未定位（${entry.anchor.reason}）`;
  return `  [${annotation.status}] ${cutAtCodePoint(annotation.id, ANNOTATION_FIELD_LIMIT)} (${entry.source}) ${excerpt} → ${cutAtCodePoint(target, ANNOTATION_FIELD_LIMIT)} · ${located}`;
};

/** An empty list still prints a line: silent success reads like "the command did not run". */
export const humanAnnotationsList = (
  annotations: readonly DocAnnotationEntry[],
  path: string,
): string =>
  term(
    `annotations ${path}（共 ${String(annotations.length)} 条）\n` +
      annotations.map((entry) => `${annotationLine(entry)}\n`).join(""),
  );

export const dataAnnotationsMigrate = (result: MigrateResult, path: string): string =>
  `{"path":${quote(path)},"migrated":${String(result.migrated)},` +
  `"skipped":${String(result.skipped)},"changed":${bool(result.changed)},` +
  `"historyPath":${result.historyPath === null ? "null" : quote(result.historyPath)},` +
  `"diagnostics":${JSON.stringify(result.diagnostics)}}`;

/** `changed:false` = nothing in hr-meta (foreign doc, or a previous run already emptied it — that is what makes migrate idempotent). */
export const humanAnnotationsMigrate = (result: MigrateResult, path: string): string =>
  result.changed
    ? term(
        `migrated ${path}（迁移 ${String(result.migrated)} 条、跳过 ${String(result.skipped)} 条）\n`,
      )
    : term(`unchanged ${path}（没有可迁移的 hr-meta 批注）\n`);

// ---- `hr meta` ----

/** The command's settled view: the record after any write, plus whether this run wrote. */
export interface MetaReport {
  readonly path: string;
  readonly meta: DocMetaRecord;
  readonly changed: boolean;
  readonly diagnostics: readonly string[];
}

export const dataMeta = (report: MetaReport): string =>
  `{"path":${quote(report.path)},"tags":${JSON.stringify(report.meta.tags)},` +
  `"sourceUrl":${report.meta.sourceUrl === undefined ? "null" : quote(report.meta.sourceUrl)},` +
  `"createdBy":${report.meta.createdBy === undefined ? "null" : quote(report.meta.createdBy)},` +
  `"savedAt":${report.meta.savedAt === undefined ? "null" : quote(report.meta.savedAt)},` +
  `"changed":${bool(report.changed)},"diagnostics":${JSON.stringify(report.diagnostics)}}`;

/** The full tag list can run ~2k chars; the human line caps it and keeps the real count. */
const tagsCell = (tags: readonly string[]): string => {
  if (tags.length === 0) return "（无）";
  const joined = term(tags.join(", "));
  return Array.from(joined).length > TABLE_CELL_LIMIT * 2
    ? `${cutAtCodePoint(joined, TABLE_CELL_LIMIT * 2)}…（共 ${String(tags.length)} 个）`
    : joined;
};

export const humanMeta = (report: MetaReport): string =>
  term(
    `meta ${report.path}（${report.changed ? "已更新" : "未改动"}）\n` +
      `  标签：${tagsCell(report.meta.tags)}\n` +
      `  来源：${report.meta.sourceUrl ?? "（无）"}\n` +
      `  创建者：${report.meta.createdBy ?? "-"} · 保存于 ${report.meta.savedAt ?? "-"}\n`,
  );

// ---- `hr search` ----

export const dataSearch = (result: LibrarySearchResult): string => JSON.stringify(result);

/** One line's snippet cell: the annotation field joins note + exact with a newline — fold it flat. */
const snippetCell = (snippet: string): string =>
  cutAtCodePoint(term(snippet.replace(/\s+/gu, " ")).trim(), ANNOTATION_FIELD_LIMIT);

const searchLine = (hit: SearchHit): string => {
  const kind =
    hit.kind === "annotation"
      ? `批注 ${cutAtCodePoint(hit.annotationId ?? "-", TABLE_CELL_LIMIT)}`
      : "文档";
  return `  ${hit.path} [${kind}] ${snippetCell(hit.snippet)}`;
};

/** An empty result still prints a line: silent success reads like "the command did not run". */
export const humanSearch = (result: LibrarySearchResult): string =>
  term(
    `search（共 ${String(result.total)} 条命中）\n` +
      result.results.map((hit) => `${searchLine(hit)}\n`).join("") +
      (result.truncated ? "  （库内文档超过索引上限，结果是前缀）\n" : ""),
  );
