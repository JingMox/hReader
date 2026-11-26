// 这层管：styles/ 下每个主题的量化可访问性门——
//   1. 按 WCAG 2.1 公式实测对比度：正文 --hr-fg、次要文字 --hr-muted 相对 --hr-bg 必须 ≥ 4.5:1，
//      代码块文字（fg/muted on --hr-code-bg）同标准；强调/警示色只报告不卡（多用于大字/装饰）。
//   2. 明暗双模：主题声明了 dark 覆盖（data-hr-mode="dark" 或 prefers-color-scheme: dark）就两套都验；
//      单模主题（如 deck-noir）只验它自己的那一套。
//   3. @media print 必须存在；动画/过渡存在时必须有 prefers-reduced-motion 收口（完全没有动效记 n/a）。
//   4. 选择器不许碰应用外壳 chrome（#hr-root/#hr-controls/…），#hr-doc 是主题的合法作用域。
// 纯 Node、零依赖：`pnpm verify` 与 CI 同一道门。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STYLES_DIR = fileURLToPath(new URL("../styles/", import.meta.url));

const SHELL_CHROME = [
  "#hr-root",
  "#hr-toc",
  "#hr-controls",
  "#hr-notes",
  "#hr-canvas",
  "#hr-present",
  "#hr-library",
  "#hr-theme-select",
];

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 提取 { selector, declarations, media }：@media 块递归进内层规则，media 记父级条件。 */
const rulesOf = (css, media = "") => {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    // 配平找对应的 }
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith("@media")) {
      rules.push(...rulesOf(body, head.slice(6).trim()));
    } else if (head.startsWith("@")) {
      // @supports/@keyframes 等：选择器语义不同，不收（@supports 内规则不属 token 层）。
      if (head.startsWith("@supports")) rules.push(...rulesOf(body, `${media} ${head}`));
    } else {
      for (const selector of head.split(",")) {
        rules.push({ selector: selector.trim(), declarations: body, media });
      }
    }
    i = j;
  }
  return rules;
};

const tokensOf = (declarations) => {
  const tokens = {};
  for (const match of declarations.matchAll(/(--hr-[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
};

/** 主题的模式集：base = :root + light 手动覆盖；dark = base + dark 手动覆盖 + 自动 dark 媒体块。 */
const modesOf = (rules) => {
  const base = {};
  const darkOver = {};
  for (const rule of rules) {
    const sel = rule.selector;
    const isRoot = /^(:root|html)\b/.test(sel) || sel.startsWith(":root");
    if (!isRoot) continue;
    // 只有顶层规则与 prefers-color-scheme 媒体块算 token 源；@media print 里的 :root 覆写
    // （打印强制白底黑字）不属于屏幕模式，混进来会把实测值换成打印值。
    const topLevel = rule.media === "";
    const inDarkMedia = /prefers-color-scheme:\s*dark/.test(rule.media);
    if (!topLevel && !inDarkMedia) continue;
    if (sel.includes('data-hr-mode="dark"') || inDarkMedia) {
      Object.assign(darkOver, tokensOf(rule.declarations));
    } else {
      Object.assign(base, tokensOf(rule.declarations));
    }
  }
  if (Object.keys(darkOver).length === 0) {
    // 单模主题（deck-noir 这类天生暗色）只有一套 token，标 default 不叫 light/dark。
    return { default: { ...base } };
  }
  // 有 dark 覆盖时 :root 就是 light（data-hr-mode="light" 与它等价）。
  return { light: { ...base }, dark: { ...base, ...darkOver } };
};

const parseColor = (value) => {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(v);
  if (hex) {
    const h = hex[1];
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    const int = Number.parseInt(full.slice(0, 6), 16);
    const alpha = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
    return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff, a: alpha };
  }
  const rgb = /^rgba?\(([^)]+)\)$/iu.exec(v);
  if (rgb) {
    const parts = rgb[1]
      .split(/[,\s/]+/u)
      .filter((p) => p !== "")
      .map(Number);
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    }
  }
  return undefined;
};

/** alpha 合成到底色上再算亮度：rgba 色值（如 --hr-accent-soft）当文字/底色用时先铺平。 */
const composite = (fg, bg) =>
  fg.a >= 1
    ? fg
    : {
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      };

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

const contrast = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

const failures = [];
const rows = [];

const check = (theme, mode, label, fgVal, bgVal, min, required) => {
  const fg = parseColor(fgVal);
  const bg = parseColor(bgVal);
  if (fg === undefined || bg === undefined) {
    failures.push(`${theme} [${mode}] ${label}: 无法解析色值 ${fgVal} / ${bgVal}`);
    return;
  }
  const bgFlat = composite(bg, { r: 255, g: 255, b: 255, a: 1 });
  const ratio = contrast(composite(fg, bgFlat), bgFlat);
  const mark = ratio >= min ? "ok" : required ? "FAIL" : "low";
  rows.push(
    `| ${theme} | ${mode} | ${label} | ${fgVal} / ${bgVal} | ${ratio.toFixed(2)}:1 | ${mark} |`,
  );
  if (required && ratio < min) {
    failures.push(`${theme} [${mode}] ${label}: ${ratio.toFixed(2)}:1 < ${min}:1`);
  }
};

for (const dir of readdirSync(STYLES_DIR).sort()) {
  const file = join(STYLES_DIR, dir, "theme.css");
  let css;
  try {
    css = readFileSync(file, "utf8");
  } catch {
    continue; // styles/ 下非主题目录（无 theme.css）跳过
  }
  const clean = stripComments(css);
  const rules = rulesOf(clean);
  const modes = modesOf(rules);

  for (const [mode, tokens] of Object.entries(modes)) {
    const bg = tokens["--hr-bg"];
    if (bg === undefined) {
      failures.push(`${dir} [${mode}]: 缺 --hr-bg`);
      continue;
    }
    for (const [name, label] of [
      ["--hr-fg", "正文 fg/bg"],
      ["--hr-muted", "次要 muted/bg"],
    ]) {
      if (tokens[name] === undefined) {
        failures.push(`${dir} [${mode}]: 缺 ${name}`);
        continue;
      }
      check(dir, mode, label, tokens[name], bg, 4.5, true);
    }
    const codeBg = tokens["--hr-code-bg"];
    if (codeBg !== undefined) {
      check(dir, mode, "code fg/code-bg", tokens["--hr-fg"], codeBg, 4.5, true);
      check(dir, mode, "code muted/code-bg", tokens["--hr-muted"], codeBg, 4.5, true);
    }
    const surface = tokens["--hr-surface"];
    if (surface !== undefined) {
      check(dir, mode, "surface fg/surface", tokens["--hr-fg"], surface, 4.5, true);
    }
    for (const name of ["--hr-accent", "--hr-warning"]) {
      if (tokens[name] !== undefined) {
        check(dir, mode, `${name.slice(5)}/bg`, tokens[name], bg, 3.0, false);
      }
    }
  }

  // 结构性检查
  if (!/@media\s+print/u.test(clean)) {
    failures.push(`${dir}: 缺 @media print`);
  }
  const hasMotion = /\btransition\b|\banimation\b|@keyframes/u.test(clean);
  const hasReducedMotion = /prefers-reduced-motion/u.test(clean);
  if (hasMotion && !hasReducedMotion) {
    failures.push(`${dir}: 有动效但无 prefers-reduced-motion`);
  }
  rows.push(
    `| ${dir} | - | reduced-motion | ${hasMotion ? (hasReducedMotion ? "guarded" : "MISSING") : "n/a (无动效)"} | - | ${hasMotion && !hasReducedMotion ? "FAIL" : "ok"} |`,
  );
  rows.push(
    `| ${dir} | - | @media print | ${/@media\s+print/u.test(clean) ? "present" : "MISSING"} | - | ${/@media\s+print/u.test(clean) ? "ok" : "FAIL"} |`,
  );
  for (const chrome of SHELL_CHROME) {
    if (clean.includes(chrome)) {
      failures.push(`${dir}: 选择器泄漏到应用外壳 ${chrome}`);
    }
  }
}

process.stdout.write("| theme | mode | pair | colors | contrast | status |\n");
process.stdout.write("|---|---|---|---|---|---|\n");
for (const row of rows) process.stdout.write(`${row}\n`);

if (failures.length > 0) {
  process.stderr.write("\n主题可访问性检查失败：\n");
  for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write(`\n${String(rows.length)} 项检查全部通过。\n`);
