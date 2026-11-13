// 这层管：风格子模块门面（加载/编译/校验/换肤 + 类型）；不承载实现逻辑。

export { applyStyle } from "./applyFile";
export { replaceTheme } from "./apply";
export type { ReplaceThemeResult } from "./apply";
export { assertThemeSafe } from "./css";
export { compileTone } from "./tone";
export { LINT_HIT_LIMIT, lintByStyle } from "./lint";
export { discoverStyles, loadStyle } from "./load";
export { nodeStyleDeps } from "./node";
export { BUILTIN_STYLES, DEFAULT_STYLE_ID, findBuiltinStyle } from "./presets";
export { loadThemeCss, resolveThemePath } from "./theme";
export type {
  ApplyStyleInput,
  ApplyStyleResult,
  ExampleSpec,
  LanguageSpec,
  LintHit,
  LintReport,
  LoadedStyle,
  LoadStyleInput,
  SentenceRhythmSpec,
  StyleDeps,
  StyleDiagnostic,
  StyleDiscovery,
  StyleSource,
  StyleSpec,
  VocabularySpec,
} from "./contracts";
