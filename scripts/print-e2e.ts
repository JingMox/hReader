// Runs the print pipeline once in real Chrome (produces a PDF → verifies pagination/paper/
// background/no external links; the long-image half lives in `print-e2e-png.ts`); not part of
// `test:unit`.
//
// Rule: when Chrome is missing or `HREADER_SKIP_CHROME=1`, **print** SKIPPED + the reason and exit
// 0 — a silent skip would fake a pass. CI that must really run sets `CHROME_BIN` explicitly.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skipLineOf, skipReasonOf } from "../packages/cli/src/commands/print-skip.ts";
import { longCheckOf } from "./print-e2e-png.ts";

/** Via the real CLI: what this smoke must prove is exactly "the repo's layers still print when wired together"; importing the renderer would bypass the wiring. */
const CLI_MAIN = join(import.meta.dirname, "../packages/cli/src/main.ts");

/** Artifacts come from the CLI, so this script needs no `@hreader/*` dependency (the root has none, and should have none). */

const CANDIDATES = [
  process.env["CHROME_BIN"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/** Four chapters: `section.chapter` carries `break-before: page`; the differential case needs it to tell "rule effective" from "content happens to be long". */
const ARTICLE = [
  '<article data-hr-id="doc">',
  "<h1>打印冒烟稿</h1>",
  "<p>这一篇只为了撑到两页：分页、纸张尺寸、背景色都必须在真浏览器里成立。</p>",
  ...Array.from({ length: 4 }, (_, chapter) =>
    [
      `<section data-hr-id="s${String(chapter)}">`,
      `<h2>第 ${String(chapter + 1)} 章</h2>`,
      ...Array.from(
        { length: 10 },
        (_, index) =>
          `<p>第 ${String(index + 1)} 段：用于制造足够高度的正文，检查分页是否真的发生。</p>`,
      ),
      "</section>",
    ].join(""),
  ),
  "</article>",
].join("");

/** The probe result is handed to the pure function via `CHROME_BIN`: decision and wording live in `print-skip.ts` (unit-testable); this file only does fs and exit. */
const chromeEnvOf = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => ({
  ...env,
  CHROME_BIN: CANDIDATES.find((path) => path !== undefined && existsSync(path)),
});

const chromeOf = (): string => {
  const env = chromeEnvOf(process.env);
  const reason = skipReasonOf(env);
  if (reason !== null) {
    process.stdout.write(skipLineOf(reason));
    process.exit(0);
  }
  return env["CHROME_BIN"] ?? "";
};

const printableHtmlOf = (dir: string): string => {
  writeFileSync(join(dir, "source.html"), ARTICLE);
  execFileSync(
    process.execPath,
    [CLI_MAIN, "export", "source.html", "--out", "print.html", "--workspace", dir],
    { cwd: dir, stdio: "pipe", timeout: 60_000 },
  );
  return readFileSync(join(dir, "print.html"), "utf8");
};

const pdfOf = (html: string, dir: string, name = "print"): Buffer => {
  const htmlPath = join(dir, `${name}.html`);
  const pdfPath = join(dir, `${name}.pdf`);
  writeFileSync(htmlPath, html);
  execFileSync(
    chromeOf(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: "pipe", timeout: 60_000 },
  );
  return readFileSync(pdfPath);
};

const countOf = (pdf: string, pattern: RegExp): number => (pdf.match(pattern) ?? []).length;
const failures: string[] = [];
const check = (ok: boolean, name: string): void => {
  if (!ok) failures.push(name);
};

/** Paper: A4 = 595.28 × 841.89 pt; Chrome rounds to 594.96 × 841.92, so compare with 1.5pt tolerance. */
const isA4Of = (pdf: string): boolean => {
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/u.exec(pdf);
  const width = Number(box?.[1] ?? Number.NaN);
  const height = Number(box?.[2] ?? Number.NaN);
  return Math.abs(width - 595.28) < 1.5 && Math.abs(height - 841.89) < 1.5;
};

/** Background: the **last** declaration of `--hr-bg` must be white (that is what the trailing `@media print` in the theme is for). */
const endsOnWhiteOf = (html: string): boolean => {
  const backgrounds = [...html.matchAll(/--hr-bg:\s*([^;]+);/gu)].map((match) =>
    (match[1] ?? "").trim().toLowerCase(),
  );
  return backgrounds.at(-1) === "#ffffff";
};

/** The PDF half: pagination / paper / white background / no external links. Returns the segment for the OK line. */
const pdfChecksOf = (dir: string, html: string): string => {
  const pdf = pdfOf(html, dir).toString("latin1");

  check(pdf.startsWith("%PDF"), "产物不是 PDF");
  // Pagination: `/Type /Page` (excluding `/Pages`) must occur at least twice to count as a real page break.
  check(countOf(pdf, /\/Type\s*\/Page[^s]/gu) >= 2, "没有跨页（页数 < 2）");
  check(isA4Of(pdf), "纸张不是 A4");
  check(endsOnWhiteOf(html), "纸面背景不是白色（暗色块压过了打印块）");
  check(/background:\s*#ffffff/iu.test(html), "缺少显式白底");
  // The artifact must not carry any networkable absolute address.
  check(!/https?:\/\//iu.test(html), "产物含 http(s):// 残留");

  // Direct evidence for the pagination rule: the same page minus break rules must change page count, or "2 pages" is a coincidence.
  const stripped = html.replaceAll(
    /(?:^|[;{\s])(?:page-)?break-(?:before|after|inside)\s*:[^;}]*;?/giu,
    "",
  );
  check(stripped !== html, "产物里没有 break-* 规则，差分用例不成立");
  const pages = countOf(pdf, /\/Type\s*\/Page[^s]/gu);
  const pagesWithoutBreaks = countOf(
    pdfOf(stripped, dir, "nobreaks").toString("latin1"),
    /\/Type\s*\/Page[^s]/gu,
  );
  check(
    pagesWithoutBreaks < pages,
    `去掉分页规则后页数没变（${String(pages)} → ${String(pagesWithoutBreaks)}），规则层未生效`,
  );
  return `分页 / A4 / 白底 / 无外链（${String(pages)} 页；抽掉分页规则后 ${String(pagesWithoutBreaks)} 页）`;
};

const main = (): void => {
  const chrome = chromeOf();
  const dir = mkdtempSync(join(tmpdir(), "hr-print-e2e-"));
  const html = printableHtmlOf(dir);
  const long = longCheckOf({ cliMain: CLI_MAIN, chrome, dir });
  const notes = [pdfChecksOf(dir, html), long.note].filter((note) => note !== "");
  failures.push(...long.failures);

  if (failures.length > 0) {
    process.stdout.write(`FAILED: ${failures.join("; ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`OK: ${notes.join("｜")}\n`);
};

main();
