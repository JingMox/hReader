// 这层管：风格测试的公共装配（假 fs + 假时钟 + 三级根），不碰真盘、不读真 HOME。

import type { LanguageSpec, StyleDeps, StyleSpec } from "../../src/style/contracts";
import { depsOf, fakeFs, fixedClock, recordingSleep, type FakeFs } from "../io/harness";

export const ROOT = "/work";

export const HOME = `${ROOT}/home`;
export const STYLES = `${ROOT}/styles`;

export interface StyleEnv {
  readonly fake: FakeFs;
  readonly deps: StyleDeps;
  readonly advance: (ms: number) => void;
}

/** 种子里的文件 ⇒ 补齐所有祖先目录（假 fs 的 readdir 只认精确的 dirs 集合）。 */
const ancestorsOf = (path: string): readonly string[] => {
  const parts = path.split("/");
  return parts.slice(1, -1).map((_, index) => parts.slice(0, index + 2).join("/"));
};

export const styleEnv = (seed: Readonly<Record<string, string>>): StyleEnv => {
  const fake = fakeFs(seed);
  for (const path of Object.keys(seed)) {
    for (const dir of ancestorsOf(path)) fake.state.dirs.add(dir);
  }
  const clock = fixedClock(1_700_000_000_000);
  const deps: StyleDeps = {
    ...depsOf(fake.port, clock.clock, recordingSleep(clock).sleep),
    home: HOME,
    projectRoot: ROOT,
    stylesRoot: STYLES,
  };
  return { fake, deps, advance: clock.advance };
};

export const THEME_CSS = ":root{--hr-bg:#faf8f5}\nbody{color:#1b1a17}\n";

/** 内置主题的最小种子：`inheritsVisual` 去重后每个 visual 一份 theme.css（deck-noir 独立成目录）。 */
export const builtinSeed = (css: string = THEME_CSS): Record<string, string> => ({
  [`${STYLES}/atelier-editorial/theme.css`]: css,
  [`${STYLES}/deck-noir/theme.css`]: css,
});

export const USER_STYLE = (id: string): string => `${HOME}/.hreader/styles/${id}/style.yaml`;
export const USER_THEME = (id: string): string => `${HOME}/.hreader/styles/${id}/theme.css`;
export const PROJECT_STYLE = `${ROOT}/.hreader/style.yaml`;

export const STYLE_YAML = (
  id: string,
  description = "测试用风格",
  inherits = "atelier-editorial",
): string =>
  [
    `id: ${id}`,
    `name: ${id} 的名字`,
    `description: ${description}`,
    `inherits_visual: ${inherits}`,
    "language_style:",
    "  persona: 讲人话。",
    "  narrative_rules:",
    "    - 先说结论。",
    "  sentence_rhythm:",
    "    max_paragraph_sentences: 3",
    "  vocabulary:",
    "    forbidden: [首先]",
    "",
  ].join("\n");

/** 调性编译的最小规格：语言五组全都非空，单测再按需覆盖成 `withLanguage`。 */
export const TONE_SPEC: StyleSpec = {
  id: "quiet-clerk",
  name: "安静的书记员",
  description: "少形容词。",
  inheritsVisual: "atelier-editorial",
  language: {
    persona: "只说能核对的话。",
    narrativeRules: ["一句话只放一个判断。"],
    rhythm: { maxParagraphSentences: 2, style: "短句为主。" },
    vocabulary: { forbidden: ["赋能"], recommended: ["换句话说"] },
    examples: [{ bad: "赋能业务。", good: "周转从 9 天降到 6 天。" }],
  },
};

export const withLanguage = (patch: Partial<LanguageSpec>): StyleSpec => ({
  ...TONE_SPEC,
  language: { ...TONE_SPEC.language, ...patch },
});

export const sectionHeadings = (markdown: string): readonly string[] =>
  markdown.split("\n").filter((line) => /^#{1,3} /u.test(line));
