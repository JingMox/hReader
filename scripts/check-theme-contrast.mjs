// Quantitative accessibility gate for every theme under packages/core/themes/ —
//   1. Contrast measured by the WCAG 2.1 formula: body --hr-fg and secondary --hr-muted against
//      --hr-bg must be ≥ 4.5:1, code-block text (fg/muted on --hr-code-bg) to the same standard;
//      accent/warning colors are reported but not gated (mostly large text/decoration).
//   2. Dual mode: a theme declaring a dark override (data-hr-mode="dark" or
//      prefers-color-scheme: dark) is verified on both sets; a single-mode theme (e.g. deck-noir)
//      only on its own.
//   3. @media print must exist; any animation/transition requires a prefers-reduced-motion
//      fallback (none at all records n/a).
//   4. Selectors must not touch the app-shell chrome (#hr-root/#hr-controls/…); #hr-doc is a
//      theme's legitimate scope.
// Pure Node, zero deps: one gate shared by `pnpm verify` and CI.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STYLES_DIR = fileURLToPath(new URL("../packages/core/themes/", import.meta.url));

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

/** Extracts { selector, declarations, media }: @media blocks recurse into inner rules, `media` records the parent condition. */
const rulesOf = (css, media = "") => {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    // Balance braces to find the matching }
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
      // @supports/@keyframes etc.: different selector semantics, not collected (rules inside @supports are not token-layer).
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

/** A theme's mode set: base = :root + manual light override; dark = base + manual dark override + automatic dark media blocks. */
const modesOf = (rules) => {
  const base = {};
  const darkOver = {};
  for (const rule of rules) {
    const sel = rule.selector;
    const isRoot = /^(:root|html)\b/.test(sel) || sel.startsWith(":root");
    if (!isRoot) continue;
    // Only top-level rules and prefers-color-scheme media blocks count as token sources; a :root
    // override inside @media print (forced white-on-black for print) is not a screen mode, and
    // letting it in would swap the measured values for print ones.
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
    // A single-mode theme (deck-noir is natively dark) has one token set, labeled default rather than light/dark.
    return { default: { ...base } };
  }
  // With a dark override present, :root is the light set (data-hr-mode="light" is equivalent).
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

/** Composite alpha onto the base color before computing luminance: an rgba value (e.g. --hr-accent-soft) is flattened before use as text/base. */
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
    failures.push(`${theme} [${mode}] ${label}: cannot parse color values ${fgVal} / ${bgVal}`);
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
    continue; // non-theme directories under the themes dir (no theme.css) are skipped
  }
  const clean = stripComments(css);
  const rules = rulesOf(clean);
  const modes = modesOf(rules);

  for (const [mode, tokens] of Object.entries(modes)) {
    const bg = tokens["--hr-bg"];
    if (bg === undefined) {
      failures.push(`${dir} [${mode}]: missing --hr-bg`);
      continue;
    }
    for (const [name, label] of [
      ["--hr-fg", "body fg/bg"],
      ["--hr-muted", "secondary muted/bg"],
    ]) {
      if (tokens[name] === undefined) {
        failures.push(`${dir} [${mode}]: missing ${name}`);
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

  // Structural checks
  if (!/@media\s+print/u.test(clean)) {
    failures.push(`${dir}: missing @media print`);
  }
  const hasMotion = /\btransition\b|\banimation\b|@keyframes/u.test(clean);
  const hasReducedMotion = /prefers-reduced-motion/u.test(clean);
  if (hasMotion && !hasReducedMotion) {
    failures.push(`${dir}: has motion but no prefers-reduced-motion`);
  }
  rows.push(
    `| ${dir} | - | reduced-motion | ${hasMotion ? (hasReducedMotion ? "guarded" : "MISSING") : "n/a (no motion)"} | - | ${hasMotion && !hasReducedMotion ? "FAIL" : "ok"} |`,
  );
  rows.push(
    `| ${dir} | - | @media print | ${/@media\s+print/u.test(clean) ? "present" : "MISSING"} | - | ${/@media\s+print/u.test(clean) ? "ok" : "FAIL"} |`,
  );
  for (const chrome of SHELL_CHROME) {
    if (clean.includes(chrome)) {
      failures.push(`${dir}: selector leaks into app chrome ${chrome}`);
    }
  }
}

process.stdout.write("| theme | mode | pair | colors | contrast | status |\n");
process.stdout.write("|---|---|---|---|---|---|\n");
for (const row of rows) process.stdout.write(`${row}\n`);

if (failures.length > 0) {
  process.stderr.write("\nTheme accessibility checks failed:\n");
  for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
  process.exit(1);
}
process.stdout.write(`\nAll ${String(rows.length)} checks passed.\n`);
