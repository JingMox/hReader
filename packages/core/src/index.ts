// 这层管：`@hreader/core` 唯一公开入口（按 docs/02 §5.2 的极小导出面）；不承载实现。

export { HrError } from "./hr-error";
export type { HrErrorCode } from "./hr-error";
export { injectNodeIds, parseHtml, serializeHtml } from "./html";
export { toDocumentModel, validateDocument } from "./model";
export type { DocumentModel } from "./model";
export { buildOutline, readNode } from "./ops";
export type { Outline, OutlineNode, PendingAnnotation, ReadNodeResult } from "./ops";
export { applyPatch, parseFragment } from "./ops";
export type { PatchAction, PatchOutcome, PatchRequest } from "./ops";
export { nodePatchDeps, patchFile, undoPatch } from "./io";
export {
  applyStyle,
  assertThemeSafe,
  BUILTIN_STYLES,
  compileTone,
  DEFAULT_STYLE_ID,
  discoverStyles,
  findBuiltinStyle,
  LINT_HIT_LIMIT,
  lintByStyle,
  loadStyle,
  loadThemeCss,
  nodeStyleDeps,
  replaceTheme,
  resolveThemePath,
} from "./style";
export type {
  ApplyStyleInput,
  ApplyStyleResult,
  ExampleSpec,
  LanguageSpec,
  LintHit,
  LintReport,
  LoadedStyle,
  LoadStyleInput,
  ReplaceThemeResult,
  SentenceRhythmSpec,
  StyleDeps,
  StyleDiagnostic,
  StyleDiscovery,
  StyleSource,
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
