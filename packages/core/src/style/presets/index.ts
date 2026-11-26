// 这层管：内置预设清单与按 id 查找（TS 数据模块，运行时不需要 fs）。

import type { StyleSpec } from "../contracts";
import { ATELIER_EDITORIAL } from "./atelier-editorial";
import { DECK_NOIR } from "./deck-noir";
import { EXECUTIVE_BRIEF } from "./executive-brief";
import { FEYNMAN_TECH } from "./feynman-tech";

/** 默认风格：无参数加载时用它。 */
export const DEFAULT_STYLE_ID = "atelier-editorial";

export const BUILTIN_STYLES: readonly StyleSpec[] = [
  ATELIER_EDITORIAL,
  FEYNMAN_TECH,
  EXECUTIVE_BRIEF,
  DECK_NOIR,
];

export const findBuiltinStyle = (id: string): StyleSpec | undefined =>
  BUILTIN_STYLES.find((style) => style.id === id);
