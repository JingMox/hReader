// The "Exit codes" section of `packages/cli/README.md` is the **only textual version** of the exit-code contract; the code-side source of truth is `src/exit-codes.ts`.
// This layer reconciles the two halves as text: add/remove/change a row in the doc, or one number in the code, and it goes red immediately.
// Text, not imports: `EXIT_CODES` is a private symbol (only `exitCodeOf` is exported), and running 41
// subprocesses to fetch each `--json` envelope is too costly — most codes have no cheap trigger path. Text reconciliation is the lightest way to the criterion.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pkgPath = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));

const README = pkgPath("README.md");
const EXIT_CODES_SRC = pkgPath("src/exit-codes.ts");

/** Take only the "Exit codes" section: from `## Exit codes` to the next `## ` heading. */
const exitTableSectionOf = (markdown: string): string => {
  const start = markdown.indexOf("## Exit codes");
  if (start < 0) throw new Error('section "## Exit codes" not found in packages/cli/README.md');
  const rest = markdown.slice(start);
  const end = rest.indexOf("\n## ", 1);
  return end < 0 ? rest : rest.slice(0, end);
};

/** Table row → `code → exit code`. One row may list several codes (`| \`a\` / \`b\` | 1 |`); every code must appear. */
const docTableOf = (section: string): ReadonlyMap<string, number> => {
  const entries = new Map<string, number>();
  for (const line of section.split("\n")) {
    const row = /^\|\s*(.+?)\s*\|\s*(\d+)\s*\|/u.exec(line);
    if (row === null) continue;
    const codes = [...String(row[1]).matchAll(/`([a-z][a-z0-9_]*)`/gu)].map((match) =>
      String(match[1]),
    );
    for (const code of codes) entries.set(code, Number(row[2]));
  }
  return entries;
};

/** ESLint-style constant table: `export const EXIT_FAILURE = 1;`. */
const constantsOf = (source: string): ReadonlyMap<string, number> => {
  const constants = new Map<string, number>();
  for (const match of source.matchAll(/const\s+(EXIT_[A-Z_]+)\s*=\s*(\d+)\s*;/gu)) {
    constants.set(String(match[1]), Number(match[2]));
  }
  return constants;
};

/** `EXIT_CODES` entries: `invalid_html: EXIT_FAILURE,` (comment lines match too, so examples inside comments are also counted as real entries). */
const codeTableOf = (source: string): ReadonlyMap<string, number> => {
  const constants = constantsOf(source);
  const body = source.slice(source.indexOf("const EXIT_CODES = {"));
  const entries = new Map<string, number>();
  for (const match of body.matchAll(/^\s{2}([a-z][a-z0-9_]*):\s*(EXIT_[A-Z_]+),/gmu)) {
    const value = constants.get(String(match[2]));
    if (value === undefined) throw new Error(`EXIT_CODES 引用了未定义的常量：${String(match[2])}`);
    entries.set(String(match[1]), value);
  }
  return entries;
};

/** Compare only the code set and values, output as readable diff lines (when red you see directly which are missing/extra/different). */
const differencesOf = (
  docs: ReadonlyMap<string, number>,
  code: ReadonlyMap<string, number>,
): readonly string[] => {
  const lines: string[] = [];
  for (const [name, value] of code) {
    const documented = docs.get(name);
    if (documented === undefined) lines.push(`docs 缺 ${name}（代码侧 ${String(value)}）`);
    else if (documented !== value)
      lines.push(`${name}: docs ${String(documented)} ≠ 代码 ${String(value)}`);
  }
  for (const name of docs.keys()) {
    if (!code.has(name)) lines.push(`docs 多出 ${name}（代码侧没有这个码）`);
  }
  return lines;
};

const documented = docTableOf(exitTableSectionOf(readFileSync(README, "utf8")));
const inCode = codeTableOf(readFileSync(EXIT_CODES_SRC, "utf8"));

describe("exit-code table reconciliation · CLI README ↔ exit-codes.ts", () => {
  it("should parse a non-trivial table on both sides (guards the parser itself)", () => {
    // Parser regressions (e.g. renamed heading, table turned into a list) would turn the `toEqual([])` below into a forever-green fake.
    expect(documented.size).toBeGreaterThanOrEqual(30);
    expect(inCode.size).toBeGreaterThanOrEqual(30);
    expect(documented.get("invalid_html")).toBe(1);
    expect(inCode.get("duplicate_id")).toBe(2);
  });

  it("should agree on every code's exit code", () => {
    expect(differencesOf(documented, inCode)).toEqual([]);
  });
});
