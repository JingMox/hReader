// 这层管：真 Chrome 跑一遍打印稿（出 PDF → 断分页/纸张/背景/无外链）；不进 `test:unit`。
//
// 规矩：Chrome 缺失或 `HREADER_SKIP_CHROME=1` 时**打印** SKIPPED + 原因并以 0 退出——
// 静默跳过等于假装跑过（§13 / 卡片 AC-6）。需要真跑的 CI 请显式给 `CHROME_BIN`。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skipLineOf, skipReasonOf } from "../packages/cli/src/commands/printSkip.ts";

/** 走真 CLI：这条烟测要证的正是"仓内各层接起来还能打"，直接 import 渲染器会绕开接线。 */
const CLI_MAIN = join(import.meta.dirname, "../packages/cli/src/main.ts");

/** 产物从 CLI 拿，故脚本本身不需要 `@hreader/*` 依赖（根目录没有，也不该有）。 */

const CANDIDATES = [
  process.env["CHROME_BIN"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/** 分四章：`section.chapter` 带 `break-before: page`，差分用例要靠它把"规则生效"与"内容恰好够长"分开。 */
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

/** 探测结果经 `CHROME_BIN` 交回纯函数：判定与文案在 `printSkip.ts`（可单测），这里只管 fs 与退出。 */
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

/** 纸张：A4 = 595.28 × 841.89 pt；Chrome 会舍入成 594.96 × 841.92，故按 1.5pt 容差比。 */
const isA4Of = (pdf: string): boolean => {
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/u.exec(pdf);
  const width = Number(box?.[1] ?? Number.NaN);
  const height = Number(box?.[2] ?? Number.NaN);
  return Math.abs(width - 595.28) < 1.5 && Math.abs(height - 841.89) < 1.5;
};

/** 背景：`--hr-bg` 的**最后**一条声明必须是白色（主题里靠后的 `@media print` 就是干这个的）。 */
const endsOnWhiteOf = (html: string): boolean => {
  const backgrounds = [...html.matchAll(/--hr-bg:\s*([^;]+);/gu)].map((match) =>
    (match[1] ?? "").trim().toLowerCase(),
  );
  return backgrounds.at(-1) === "#ffffff";
};

const main = (): void => {
  chromeOf();
  const dir = mkdtempSync(join(tmpdir(), "hr-print-e2e-"));
  const html = printableHtmlOf(dir);
  const pdf = pdfOf(html, dir).toString("latin1");

  check(pdf.startsWith("%PDF"), "产物不是 PDF");
  // 分页：`/Type /Page`（不含 `/Pages`）出现两次以上才算真跨页。
  check(countOf(pdf, /\/Type\s*\/Page[^s]/gu) >= 2, "没有跨页（页数 < 2）");
  check(isA4Of(pdf), "纸张不是 A4");
  check(endsOnWhiteOf(html), "纸面背景不是白色（暗色块压过了打印块）");
  check(/background:\s*#ffffff/iu.test(html), "缺少显式白底");
  // AC-11：产物里不得有可联网的绝对地址。
  check(!/https?:\/\//iu.test(html), "产物含 http(s):// 残留");

  // AC-6 的直接证据：同一篇稿子抽掉分页规则后页数必须变，否则"2 页"只是恰好。
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

  if (failures.length > 0) {
    process.stdout.write(`FAILED: ${failures.join("; ")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `OK: 分页 / A4 / 白底 / 无外链（${String(pages)} 页；抽掉分页规则后 ${String(pagesWithoutBreaks)} 页）\n`,
  );
};

main();
