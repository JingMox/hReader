// `packages/cli/README.md` 的「Exit codes」一节是退出码契约的**唯一文字版**，代码侧的真源是 `src/exit-codes.ts`。
// 这层把两半当文本对账：文档里加/删/改一行，或代码里改一个数，必须立刻红。
// 用文本而不是 import：`EXIT_CODES` 是私有符号（只导出 `exitCodeOf`），而 41 个码各跑一次子进程
// 拿 `--json` 信封成本过高、且多数码没有便宜的触发路径——文本对账是能达到判据的最轻做法。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const pkgPath = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));

const README = pkgPath("README.md");
const EXIT_CODES_SRC = pkgPath("src/exit-codes.ts");

/** 只取「Exit codes」那一节：从 `## Exit codes` 起，到下一个 `## ` 标题止。 */
const exitTableSectionOf = (markdown: string): string => {
  const start = markdown.indexOf("## Exit codes");
  if (start < 0) throw new Error("packages/cli/README.md 里找不到「## Exit codes」这一节");
  const rest = markdown.slice(start);
  const end = rest.indexOf("\n## ", 1);
  return end < 0 ? rest : rest.slice(0, end);
};

/** 表格行 → `码 → 退出码`。一行可列多个码（`| \`a\` / \`b\` | 1 |`），每个码都要出现。 */
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

/** `ESLint` 风格的常量表：`export const EXIT_FAILURE = 1;`。 */
const constantsOf = (source: string): ReadonlyMap<string, number> => {
  const constants = new Map<string, number>();
  for (const match of source.matchAll(/const\s+(EXIT_[A-Z_]+)\s*=\s*(\d+)\s*;/gu)) {
    constants.set(String(match[1]), Number(match[2]));
  }
  return constants;
};

/** `EXIT_CODES` 的条目：`invalid_html: EXIT_FAILURE,`（注释行同样匹配，因此含注释里的例子也只按真条目算）。 */
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

/** 只比码集与数值，输出成可读的差额行（红的时候直接看得见少的/多的/不一样的是哪些）。 */
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

describe("错误码表对账 · CLI README ↔ exit-codes.ts", () => {
  it("should parse a non-trivial table on both sides (guards the parser itself)", () => {
    // 解析器退化（比如标题改名、表格改成列表）会让下面的 `toEqual([])` 变成永远绿的假证。
    expect(documented.size).toBeGreaterThanOrEqual(30);
    expect(inCode.size).toBeGreaterThanOrEqual(30);
    expect(documented.get("invalid_html")).toBe(1);
    expect(inCode.get("duplicate_id")).toBe(2);
  });

  it("should agree on every code's exit code", () => {
    expect(differencesOf(documented, inCode)).toEqual([]);
  });
});
