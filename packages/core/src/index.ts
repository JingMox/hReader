// 这层管：`@hreader/core` 唯一公开入口；不承载实现。

export { HrError } from "./hr-error";
export type { HrErrorCode, HrErrorData } from "./hr-error";
export { injectNodeIds, parseHtml, serializeHtml, hasArticle } from "./html";
export {
  attributeOf,
  hasExecutableContent,
  hasExternalResource,
  isCountedImage,
  isDroppedNode,
  sanitizedAttributesOf,
} from "./html";
export type { SanitizePreset } from "./html";
export { classifyDocument, loadDocument, toDocumentModel, validateDocument } from "./model";
export type { Classification, DocClass, DocumentLoad, DocumentModel } from "./model";
export { buildOutline, locateTarget, patchTargetIdOf, readNode } from "./ops";
export type { LocatedTarget, Outline, OutlineNode, PendingAnnotation, ReadNodeResult } from "./ops";
export { applyPatch, parseFragment } from "./ops";
export type { PatchAction, PatchOutcome, PatchRequest } from "./ops";
export {
  effectiveOf,
  isInside,
  isInsideOrSelf,
  nodePatchDeps,
  patchFile,
  readDocGrant,
  readGlobalModes,
  resolveTarget,
  undoPatch,
  writeAtomic,
} from "./io";
export type { DocGrant, EffectivePermissions, GlobalModes, ResolvedTarget, TrustLevel } from "./io";
export {
  createCapabilityBook,
  decodeParams,
  docAssetReply,
  matchRoute,
  paramOf,
  startServer,
} from "./server";
export type {
  CapabilityBook,
  DaemonInfo,
  HandlerContext,
  Reply,
  RunningServer,
  ServerDeps,
  ServerOptions,
} from "./server";
export {
  applyStyle,
  assertThemeSafe,
  BUILTIN_STYLES,
  compileTone,
  DEFAULT_STYLE_ID,
  discoverStyles,
  embeddedThemeCssOf,
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

// ---- 批注（纯层）+ 落盘编排 + 撤销 ----
export {
  ANCHOR_LIMITS,
  annotationIdOf,
  DIFF_CHAR_LIMIT,
  diffText,
  docRelocatorOf,
  elementByPath,
  matchAnchorInText,
  NOTE_LIMIT,
  parseSelectorPath,
  parseSidecarFile,
  readAnnotations,
  replyIdOf,
  resolveAnchor,
  SELECTOR_LIMITS,
  serializeSidecarFile,
  SIDECAR_LIMITS,
  SIDECAR_VERSION,
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
  RelocateResult,
  RelocateVia,
  SelectorStep,
  SidecarAnnotation,
  SidecarAuthor,
  SidecarParse,
  SidecarReply,
  TextAnchor,
  TextChunk,
} from "./annotations";
export {
  addAnnotation,
  listAnnotations,
  reopenAnnotation,
  resolveAnnotation,
} from "./ops/annotation-ops";
export type {
  AddAnnotationInput,
  AnnotationWriteResult,
  ListResult,
  ResolveInput,
} from "./ops/annotation-ops";
export {
  addSidecarAnnotation,
  deleteSidecarAnnotation,
  listDocAnnotations,
  migrateMetaAnnotations,
  reopenSidecarAnnotation,
  replySidecarAnnotation,
  resolveSidecarAnnotation,
} from "./ops/sidecar-ops";
export type {
  AddSidecarInput,
  DocAnnotationEntry,
  DocAnnotationsResult,
  MigrateResult,
  ReplySidecarInput,
  ResolveSidecarInput,
  SidecarIdInput,
  SidecarReplyResult,
  SidecarWriteResult,
} from "./ops/sidecar-ops";
export { annotationDirOf, annotationFileOf, readSidecarFile, writeSidecarFile } from "./io";
export type { SidecarFile } from "./io";
export { revertLast } from "./ops/revert-op";
export type { RevertResult } from "./ops/revert-op";
export { normalizeFile } from "./ops/normalize-file";
export type { NormalizeInput, NormalizeResult } from "./ops/normalize-file";
export { importForeign } from "./ops/import";
export type { ImportDiscard, ImportOptions, ImportReport, ImportResult } from "./ops/import";

// ---- text (pure layer): the surrogate-safe cut shared across packages ----
export { cutAtCodePoint } from "./text";

// ---- 排版约束：组件规约、写入时检查、文档形态骨架 ----
export {
  checkLayout,
  COMPONENT_RULES,
  DEFAULT_DOC_KIND,
  DOC_KINDS,
  isDocKind,
  KIND_ATTRIBUTE,
  LAYOUT_ISSUE_LIMIT,
  newDocumentHtml,
} from "./layout";
export type { ComponentRule, DocKind, NewDocumentInput } from "./layout";
