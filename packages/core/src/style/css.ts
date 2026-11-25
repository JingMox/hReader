// 这层管：主题 CSS 的静态防线（离线、不可执行）；不写盘、不解析 CSS 结构。

import { HrError } from "../hr-error";

const invalidTheme = (reason: string): HrError => new HrError("invalid_theme", reason);

/** 反斜杠转义的上限：`String.fromCodePoint` 对超范围输入会抛 `RangeError`。 */
const MAX_CODE_POINT = 0x10ffff;

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /@import/iu, reason: "禁止 @import（主题必须离线自足）" },
  { pattern: /</u, reason: "禁止出现 `<`（防止 </style> 逃出样式块）" },
  { pattern: /javascript:/iu, reason: "禁止 javascript: 伪协议" },
];

/** 参数不能闭合的 `url(` 收不到参数，单独兜底一次协议探测。 */
const EXTERNAL_URL = /url\s*\(\s*["']*\s*(?:https?:)?\/\//iu;

const URL_ARGUMENT = /url\s*\(\s*([^)]*?)\s*\)/giu;

const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * 十六进制转义（`\68 ttp` = `http`）：浏览器先解码再判定，防线也必须在解码后的文本上判。
 * `Math.min` 兜住超范围码点，省掉一个永远为假的分支。
 */
const decodeHexEscapes = (css: string): string =>
  css.replaceAll(/\\[0-9a-f]{1,6}\s?/giu, (match) =>
    String.fromCodePoint(Math.min(Number.parseInt(match.slice(1).trimEnd(), 16), MAX_CODE_POINT)),
  );

/** 单字符转义（`\.` / `\\`）：反斜杠只为转义而存在，解码结果就是后面那个字符。 */
const decodeCharEscapes = (css: string): string =>
  css.replaceAll(/\\[\s\S]/gu, (match) => match.slice(1));

/** 注释先摘掉：被注释掉的 `@import` 不是威胁，而 `/*x*\/@import` 摘完仍连着 `@import`。 */
const stripComments = (css: string): string => css.replaceAll(/\/\*[\s\S]*?(?:\*\/|$)/gu, " ");

const isLocalUrl = (argument: string): boolean => {
  const value = argument.replaceAll(/["']/gu, "").trim();
  if (value.startsWith("#") || value.startsWith("data:")) return true;
  return !value.startsWith("//") && !SCHEME.test(value);
};

const urlArgumentsOf = (css: string): readonly string[] => {
  // Stryker disable next-line ArrayDeclaration: 预填元素走同一条 isLocalUrl 判定，无害相对串只会多一次放行检查——等价。
  const found: string[] = [];
  for (const match of css.matchAll(URL_ARGUMENT)) {
    const argument = match[1];
    if (argument !== undefined) found.push(argument);
  }
  return found;
};

/** 白名单而非黑名单：`url()` 只接受 `data:`、页内锚点与相对路径。 */
const assertUrlsLocal = (css: string): void => {
  if (EXTERNAL_URL.test(css)) throw invalidTheme("url() 指向了外部资源，主题必须离线自足");
  for (const argument of urlArgumentsOf(css)) {
    if (!isLocalUrl(argument)) {
      throw invalidTheme(`url() 只允许相对路径、data: 或 #锚点，收到：${argument.trim()}`);
    }
  }
};

/** 先反转义再摘注释：两类"写法变形"都先归一，判定只看归一后的文本。 */
const normalizedOf = (css: string): string =>
  stripComments(decodeCharEscapes(decodeHexEscapes(css)));

/** 注入前必过：主题 CSS 只能静态，不能联网、不能逃出 `<style>`。 */
export const assertThemeSafe = (css: string): void => {
  // `</style` 要在归一化之前查：注释剥掉会把 `/*</style>*/` 洗成空格，但那串字节照样落进样式块、
  // 照样终结 raw text（注释里的普通 `<` 如 `<article` 不终结，仍走归一化后的 `<` 禁则放行不了注释外）。
  if (/<\/style/iu.test(css)) throw invalidTheme("禁止出现 `</style`（防止逃出样式块）");
  const normalized = normalizedOf(css);
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(normalized)) throw invalidTheme(rule.reason);
  }
  assertUrlsLocal(normalized);
};
