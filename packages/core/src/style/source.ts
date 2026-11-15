// 这层管：风格的"源文本"（自定义档给盘上原文，内置档给序列化产物）；不解析、不复刻优先级。

import { join } from "node:path";

import { stringify } from "yaml";

import { decodeUtf8 } from "../io/bytes";
import type { StyleDeps, StyleSpec } from "./contracts";
import { resolveStyle } from "./load";
import { projectStylePath, STYLE_FILE, userStyleDir } from "./resource";

/** 宿主侧（MCP 资源、prompt 编织）要的是"能读给模型看的风格定义"，不是解析后的对象。 */
export interface StyleSourceText {
  readonly yaml: string;
  /** `file` = 盘上 `style.yaml` 原文；`generated` = 内置档无源文件，由 spec 序列化而来。 */
  readonly origin: "file" | "generated";
}

/** 内置档在 `presets/*.ts` 里是 TS 数据、`styles/` 下只有 `theme.css`，故只能序列化。 */
const yamlDocOf = (spec: StyleSpec): string =>
  stringify({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inherits_visual: spec.inheritsVisual,
    language_style: {
      persona: spec.language.persona,
      narrative_rules: [...spec.language.narrativeRules],
      sentence_rhythm: {
        max_paragraph_sentences: spec.language.rhythm.maxParagraphSentences,
        style: spec.language.rhythm.style,
      },
      vocabulary: {
        forbidden: [...spec.language.vocabulary.forbidden],
        recommended: [...spec.language.vocabulary.recommended],
      },
      examples: spec.language.examples.map((example) => ({
        bad: example.bad,
        good: example.good,
      })),
    },
  });

/**
 * 谁是赢家（project → user → builtin）与未知 id 的报错都交 `resolveStyle` 裁定，
 * 这里只补"文本从哪来"：路径约定仍只在 `resource.ts` 里那一份。
 */
export const readStyleSource = async (id: string, deps: StyleDeps): Promise<StyleSourceText> => {
  const loaded = await resolveStyle({ id }, deps);
  if (loaded.source === "builtin") {
    return { yaml: yamlDocOf(loaded.spec), origin: "generated" };
  }
  const path =
    loaded.source === "project" ? projectStylePath(deps) : join(userStyleDir(id, deps), STYLE_FILE);
  return { yaml: decodeUtf8(await deps.fs.readFile(path), path), origin: "file" };
};
