// 这层管：结果 → 人读文本 / 单行 JSON（键序手写固定）；不做 IO、不判断退出码。
// `--json` 契约：恰好一个 `\n`、无缩进、无尾随空格；错误 JSON 也是单行。

import { relative, sep } from "node:path";

import type { PrintHtmlResult } from "@hreader/renderer-html";
import type {
  ApplyStyleResult,
  DaemonInfo,
  ExtractStats,
  ExtractStyleLlmResult,
  ExtractStyleResult,
  HrErrorCode,
  HrErrorData,
  ImportDiscard,
  ImportReport,
  LintHit,
  LintReport,
  Outline,
  OutlineNode,
  NormalizeResult,
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

/**
 * 回执里的路径一律按用户视角回显：文档在 cwd 内就用相对 cwd 的形式（用户本来就是这么写的），
 * 在 cwd 外（或 cwd 就是它）才印绝对路径。命令层只知道 workspace 相对名、`--out` 只知道真实路径，
 * 所以"用户给的串"只能由分发层（`run.ts`）算好后传进来；所有印路径的回执必须走同一口径。
 */
export const displayedPathOf = (path: string, cwd: string): string => {
  const rel = relative(cwd, path);
  // 逃出 cwd 才是 `..` 或 `..<sep>…`；`..foo` 只是名字以两个点开头的正常路径，不能误判成外部。
  return rel === "" || rel === ".." || rel.startsWith(".." + sep) ? path : rel;
};

const bool = (value: boolean): string => (value ? "true" : "false");

export const jsonOk = (data: string): string => `{"ok":true,"data":${data}}\n`;

/** `data` 是给调用方分支用的机器可读成因（如 `invalid_selector` 的 `reason`/`candidates`）；没有就整个键不出现。 */
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

/** 键恒在（未截断时 `false`/`[]`）：`--json` 的契约只增不减，条件键会把“键可能不存在”的分支
 * 摊给每个调用方——形状稳定的代价只是一个 `false`。 */
export const dataRead = (result: ReadNodeResult, ids: readonly string[]): string =>
  `{"html":${quote(result.html)},"ids":${JSON.stringify(ids)},` +
  `"truncated":${bool(result.truncated)},` +
  `"diagnostics":[${result.diagnostics.map(diagnosticJson).join(",")}]}`;

/** 键序固定（对外契约）；`historyPath` 为 `null` 表示没写盘（`changed:false`）。
 * `replacedIds` 只在 `replace` 让目标 id 真变了时出现：其余动作不印空数组，免得既有调用以为多了一个"映射"。
 * `warnings` 同理只在非空时出现（片段的 `duplicate_attribute` 等解析诊断）。
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

/** `out` 为 `null` = 只打 stdout；`bytes` 与落盘文件大小相等（用 `statSync` 复核过）。 */
export const dataExport = (report: PrintHtmlResult, out: string | null): string =>
  `{"html":${quote(report.html)},"bytes":${String(report.bytes)},` +
  `"droppedImages":${String(report.droppedImages)},"out":${out === null ? "null" : quote(out)}}`;

export const humanExport = (report: PrintHtmlResult): string => report.html;

export const humanExportWritten = (out: string, bytes: number): string =>
  `exported ${out} (${String(bytes)} bytes)\n`;

/** `pdf` 是产物的 base64：`--json` 要么给全部字节，要么不给（与 `dataExport` 的 `html` 同一取舍）。
 * `outline` 是**产物里的大纲条目数**（读 PDF 的 `/Outlines` 树）：`--no-outline` 或无标题时为 0。 */
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
  `${path} (${String(report.pages)} 页, ${String(report.outline)} 条书签)\n`;

/** `png` 与 `pdf` 同一取舍：`--json` 给整张图的 base64；`width`/`height` 是反读 IHDR 的设备像素
（已乘 `--scale`，与 `--width`/`--max-height` 的 CSS 像素不是一套口径，别直接对比）。 */
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
  `exported ${path} (${String(report.bytes)} bytes, ${String(report.width)}×${String(report.height)}${report.clipped ? ", clipped" : ""})\n`;

const outlineLines = (nodes: readonly OutlineNode[], depth: number): readonly string[] =>
  nodes.flatMap((node) => [
    `${"  ".repeat(depth)}- ${node.id}  ${node.text}  (${String(node.wordCount)}w)`,
    ...outlineLines(node.children, depth + 1),
  ]);

/** 空大纲不能静默：0 字节 stdout + 退出码 0 读起来像“文档没问题”，其实是“确实没标题”。
 * 第二行是给下一步的动作：没有标题的文档（论文正文、Word 导出）只能从内容里摸，`read` 就是那条路。
 * 路径默认值是给直调的单测用的占位；CLI 永远传用户视角路径。
 */
export const humanOutline = (outline: Outline, displayPath = "<文件>"): string =>
  outline.nodes.length === 0
    ? `（没有标题）\n本文没有标题；用 hr read ${displayPath} <nodeId|selector> 取内容\n`
    : [...outlineLines(outline.nodes, 0), ""].join("\n");

/** 人读模式下的诊断行：与 `--json` 的 `diagnostics` 同源，只是压成一行。 */
export const humanDiagnostic = (diagnostic: DiagnosticShape): string =>
  `${diagnostic.severity}: ${diagnostic.message}\n`;

/** 截断不能只写在 JSON 的 `diagnostics` 里：人读模式的 stdout 与未截断时逐字相同，用户只会以为节点就这么长。
 * 打的是 core 那条 `truncated_output` 原文（不另排一套数字）：两个输出源同源，就不会各说一套。
 */
export const humanRead = (result: ReadNodeResult): string => {
  const truncation = result.diagnostics.find((item) => item.code === "truncated_output");
  return `${result.html}\n${truncation === undefined ? "" : `${truncation.message}\n`}`;
};

/**
 * `replace` 会按内容重发 id：不把「旧 id → 新 id」印出来，用户手上那个旧 id 就再也不能用。
 * 映射之外的附带新 id（片段里更深层的块）照旧跟在后面；无新 id 时不印空列表，免得每行拖一串噪声。
 */
export const humanPatch = (result: PatchResult, path: string = result.path): string => {
  // 片段的解析诊断跟回执一起印：落盘了但字节里少了东西，用户得能看见。
  const warnings = (result.warnings ?? [])
    .map((diagnostic) => `warning: ${diagnostic.code} — ${diagnostic.message}\n`)
    .join("");
  if (!result.changed) {
    return `unchanged ${path} (${String(result.bytes)} bytes)\n${warnings}`;
  }
  const replaced = result.replacedIds;
  if (replaced.length === 0) {
    const ids = result.newIds.length === 0 ? "" : ` ids: ${result.newIds.join(", ")}`;
    return `patched ${path} (${String(result.bytes)} bytes, +${String(result.newIds.length)}${ids})\n${warnings}`;
  }
  const mapped = new Set(replaced.map((pair) => pair.to));
  const extras = result.newIds.filter((id) => !mapped.has(id));
  const extraText =
    extras.length === 0 ? "" : `, +${String(extras.length)} ids: ${extras.join(", ")}`;
  const pairs = replaced.map((pair) => `${pair.from} → ${pair.to}`).join(", ");
  return `patched ${path} (${String(result.bytes)} bytes, id 变更: ${pairs}${extraText})\n${warnings}`;
};

export const humanLint = (report: LintReport): string =>
  [
    ...report.hits.map((hit) => `${hit.path}:${String(hit.offset)}: ${hit.word} — ${hit.excerpt}`),
    "",
  ].join("\n");

export const humanTone = (prompt: string): string => `${prompt}\n`;

export const humanStyle = (result: ApplyStyleResult, path: string = result.path): string =>
  result.changed
    ? `styled ${path} (${String(result.bytes)} bytes)\n`
    : `unchanged ${path} (${String(result.bytes)} bytes，主题已与文档里的 <style id="hr-theme"> 一致)\n`;

/** 人能直接粘进浏览器的地址：首访带合法 token，服务端落 cookie 后 302 回干净的 `/`。 */
export const serveUrlOf = (info: DaemonInfo): string =>
  `http://127.0.0.1:${String(info.port)}/?token=${encodeURIComponent(info.token)}`;

/** `hr serve` 的第一行：端口、token 与可直接打开的地址一次性交给调用方（token 不落 CLI 日志）。 */
export const dataServe = (info: DaemonInfo): string =>
  `{"port":${String(info.port)},"token":${quote(info.token)},"url":${quote(serveUrlOf(info))},` +
  `"pid":${String(info.pid)},"workspace":${quote(info.workspace)}}`;

export const humanServe = (info: DaemonInfo, path: string = info.workspace): string =>
  `serving ${path} on ${serveUrlOf(info)} (pid ${String(info.pid)})\n`;

export const dataUndo = (result: UndoResult): string =>
  jsonOk(
    `{"path":${quote(result.path)},"bytes":${String(result.bytes)},"restoredFrom":${quote(result.restoredFrom)},"sha256":${quote(result.sha256)}}`,
  );

export const humanUndo = (result: UndoResult, path: string = result.path): string =>
  `undone ${path} (${String(result.bytes)} bytes, from ${result.restoredFrom})\n`;

/** `html` 原样进 JSON：调用方拿它能直接与磁盘/`--out` 逐字节比。 */
export const dataNormalize = (result: NormalizeResult): string =>
  `{"needsNormalize":${bool(result.needsNormalize)},"html":${quote(result.html)},"injected":${String(result.injected)}}`;

export const humanNormalizeWritten = (
  result: NormalizeResult,
  path: string = result.path,
): string =>
  result.changed
    ? `normalized ${path} (+${String(result.injected)} ids, ${String(result.bytes)} bytes)\n`
    : `unchanged ${path} (${String(result.bytes)} bytes，已带齐 data-hr-id)\n`;

export const humanStyleExtract = (result: ExtractStyleResult, path: string): string =>
  `extracted ${path} (${String(result.stats.paragraphs)} 段、${String(result.stats.sentences)} 句，` +
  `平均句长 ${String(result.stats.averageSentenceChars)} 字，每段 ≤ ${String(result.stats.maxParagraphSentences)} 句)\n`;

/** `Diagnostic` 不在 core 的公开面单列 `path` 之外的形状；这里用结构类型，与 `DiagnosticShape` 同一取舍。 */
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

/** `path` 键恒在（没有定位时为 `null`）：`--json` 的形状不随诊断种类变。 */
const issueJson = (issue: IssueShape): string =>
  JSON.stringify({
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    path: issue.path ?? null,
  });

/** `cls` 是外来 HTML 三档分类的 additive 字段；`reason` 只在 `foreign` 时给出（给人话原因）。 */
export const dataCheck = (issues: readonly IssueShape[], cls: string, reason?: string): string =>
  `{"issues":[${issues.map(issueJson).join(",")}],"count":${String(issues.length)},` +
  `"cls":${quote(cls)}${reason === undefined ? "" : `,"reason":${quote(reason)}`}}`;

const issueLine = (issue: IssueShape): string =>
  `${issue.severity}: ${issue.code} — ${issue.message}${issue.path === undefined ? "" : ` @ ${issue.path}`}\n`;

/** 外来文档的说明行：跟在诊断输出之后，告诉用户「能看、不能按块改」。 */
const FOREIGN_NOTE = "外来 HTML 文档：hReader 会以只读方式打开，不支持按块编辑\n";

/** 没问题也要有一行：0 字节 stdout 读起来像“没跑”。 */
export const humanCheck = (issues: readonly IssueShape[], path: string, foreign = false): string =>
  (issues.length === 0
    ? `ok ${path}（没有排版问题）\n`
    : `${issues.map(issueLine).join("")}${path}：${String(issues.length)} 条问题\n`) +
  (foreign ? FOREIGN_NOTE : "");

export const dataNew = (report: NewDocReport): string =>
  JSON.stringify({
    path: report.path,
    kind: report.kind,
    title: report.title,
    bytes: report.bytes,
  });

export const humanNew = (report: NewDocReport, path: string): string =>
  `created ${path} (${report.kind}, ${String(report.bytes)} bytes)\n`;

const discardJson = (item: ImportDiscard): string =>
  `{"what":${quote(item.what)},"reason":${quote(item.reason)},"count":${String(item.count)}}`;

/** 键序固定（对外契约）；`trunkTag` 只有 largest 时有值，其余恒 `null`——`--json` 的形状不随主干来源变。 */
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

/** 人读的 report 摘要：产物行 + 标题/主干/剥除统计行 + 丢弃明细（什么都没有被丢就不出那段）。 */
export const humanImport = (report: ImportReport, out: string, bytes: number): string => {
  // trunkTag 只在 largest 下有值（report 契约）：拿它当 largest 的判据就不用对 undefined 求值。
  const trunk =
    report.trunkTag !== undefined
      ? `<${report.trunkTag}>`
      : report.trunk === "main"
        ? "<main>"
        : "<body>";
  const dropped = report.discarded
    .map((item) => `\n    ${item.what} ×${String(item.count)}（${item.reason}）`)
    .join("");
  return (
    `imported ${out} (${report.kind}, ${String(report.sections)} 节, ${String(bytes)} bytes)\n` +
    `  标题「${report.title}」（${TITLE_SOURCE_LABEL[report.titleSource]}）；主干：${trunk}；` +
    `剥除元素 ${String(report.removedElements)} 个、属性 ${String(report.strippedAttributes)} 个` +
    `${dropped === "" ? "" : `\n  丢弃明细：${dropped}`}\n`
  );
};
