// 这层管：`@hreader/core` 唯一公开入口（公共出口清单见 `.workflow/cards/R3.md` D1–D8 接口冻结表与 docs/05 M1.8）；不承载实现。

export { HrError } from "./hr-error";
export type { HrErrorCode, HrErrorData } from "./hr-error";
export { injectNodeIds, parseHtml, serializeHtml, hasArticle } from "./html";
export { toDocumentModel, validateDocument } from "./model";
export type { DocumentModel } from "./model";
export { buildOutline, locateTarget, patchTargetIdOf, readNode } from "./ops";
export type { LocatedTarget, Outline, OutlineNode, PendingAnnotation, ReadNodeResult } from "./ops";
export { applyPatch, parseFragment } from "./ops";
export type { PatchAction, PatchOutcome, PatchRequest } from "./ops";
export { isInside, isInsideOrSelf, nodePatchDeps, patchFile, undoPatch, writeAtomic } from "./io";
export { startServer } from "./server";
export type { DaemonInfo, RunningServer, ServerDeps, ServerOptions } from "./server";
export {
  applyStyle,
  assertThemeSafe,
  BUILTIN_STYLES,
  compileTone,
  DEFAULT_STYLE_ID,
  discoverStyles,
  extractStyle,
  extractStyleWithLlm,
  findBuiltinStyle,
  LINT_HIT_LIMIT,
  lintByStyle,
  loadStyle,
  loadThemeCss,
  nodeStyleDeps,
  projectStylePath,
  readStyleSource,
  replaceTheme,
  resolveThemePath,
  saveStyleText,
  STYLE_FILE,
  userStyleDir,
} from "./style";
export type {
  ApplyStyleInput,
  ApplyStyleResult,
  CorpusFormat,
  CorpusText,
  ExampleSpec,
  ExtractStats,
  ExtractStyleInput,
  ExtractStyleLlmInput,
  ExtractStyleLlmResult,
  ExtractStyleResult,
  LanguageSpec,
  LintHit,
  LintReport,
  LoadedStyle,
  LoadStyleInput,
  ReplaceThemeResult,
  SavedStyle,
  SaveStyleTextInput,
  SentenceRhythmSpec,
  StyleDeps,
  StyleDiagnostic,
  StyleDiscovery,
  StyleSource,
  StyleSourceText,
  StyleSpec,
  VocabularySpec,
} from "./style";
export type {
  Clock,
  FileStat,
  FileSystem,
  PatchDeps,
  PatchFileInput,
  PatchOptions,
  PatchResult,
  PatchTargetInput,
  UndoResult,
} from "./io";
// 其余结构类型（attrs/各叶子节点）收在 src/html/index.ts：消费方经 `HtmlNode` 联合自取，
// 入口重复导出只会让"极小导出面"名存实亡。
export type {
  Diagnostic,
  DiagnosticCode,
  HtmlElementNode,
  HtmlNode,
  InjectedNodeIds,
  ParsedHtml,
} from "./html";

// ---- M2.3：批注（纯层）+ 落盘编排 + 撤销 ----
export {
  ANCHOR_LIMITS,
  annotationIdOf,
  DIFF_CHAR_LIMIT,
  diffText,
  NOTE_LIMIT,
  readAnnotations,
  resolveAnchor,
  writeAnnotations,
} from "./annotations";
export type {
  AnchorDocument,
  AnchorFailure,
  AnchorResult,
  Annotation,
  AnnotationStatus,
  ChunkKind,
  DiffResult,
  ReadResult,
  TextAnchor,
  TextChunk,
} from "./annotations";
export {
  addAnnotation,
  listAnnotations,
  reopenAnnotation,
  resolveAnnotation,
} from "./ops/annotationOps";
export type {
  AddAnnotationInput,
  AnnotationWriteResult,
  ListResult,
  ResolveInput,
} from "./ops/annotationOps";
export { revertLast } from "./ops/revertOp";
export type { RevertResult } from "./ops/revertOp";
export { normalizeFile } from "./ops/normalizeFile";
export type { NormalizeInput, NormalizeResult } from "./ops/normalizeFile";
