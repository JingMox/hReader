// 重复 `data-hr-id` 的文案归一。
//
// 老文案说"`read`/`patch` 只会命中第一个"，而实现是**进定位之前就退出 2**（`duplicate_id`）——
// 报文让人预测到的行为与实测相反，这是用户唯一能读到的契约，所以两侧都要钉：
// ① 过期措辞 `只会命中第一个` 在 `packages/*/src` 与 `docs` 下**零命中**（注释/报文/文档都算）；
// ② 新报文必须给出可执行的那一步（`先跑 hr normalize <file> --write`），并说清"重复的那处永远读不到"；
// ③ 退出码 2（用法/内容错误），不是 1（目标找不到）——它连定位都没进。
//
// 断言钉外部可观察物：源码文件内容、`--json` 信封、退出码。

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const OBSOLETE = "只会命中第一个";

/** 文案归一的作用域：实现与文档（历史评审归档不算，它们记录的是改动前的事实）。 */
const SCOPES = ["packages/core/src", "packages/cli/src", "docs"] as const;

const filesUnder = (dir: string): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return /\.(ts|md)$/.test(entry.name) ? [path] : [];
  });

const DUP = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  '<p data-hr-id="hr-x">第一处</p>',
  '<p data-hr-id="hr-x">第二处</p>',
  "</article></body></html>",
].join("\n");

describe("过期文案零命中", () => {
  it.each(SCOPES)("should not keep the obsolete wording under %s", (scope) => {
    const offenders = filesUnder(join(ROOT, scope)).filter((path) =>
      readFileSync(path, "utf8").includes(OBSOLETE),
    );

    expect(offenders).toEqual([]);
  });
});

describe("duplicate_id 报文给出可执行的那一步", () => {
  it("should tell the user to run `hr normalize <file> --write` (read)", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUP);
      const result = await runCli(["read", "a.html", "hr-x", "--json"], { cwd: dir });
      const parsed = parseJsonLine(result.stdout);
      const message = String(fieldOf(parsed, "message"));

      expect(result.code).toBe(2);
      expect(fieldOf(parsed, "code")).toBe("duplicate_id");
      expect(message).toContain('两个元素共用 data-hr-id "hr-x"');
      expect(message).toContain("永远读不到");
      // 路径形态随命令路径不同（read 报 realpath，patch 报用户输入的相对路径）：钉“可照抄的命令”本身。
      expect(message).toMatch(/先跑 hr normalize \S*a\.html --write/);
      expect(message).not.toContain(OBSOLETE);
    });
  });

  it("should refuse patch with the same code and wording", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUP);
      const result = await runCli(["patch", "a.html", "hr-x", "--action", "delete", "--json"], {
        cwd: dir,
      });
      const parsed = parseJsonLine(result.stdout);
      const message = String(fieldOf(parsed, "message"));

      expect(result.code).toBe(2);
      expect(fieldOf(parsed, "code")).toBe("duplicate_id");
      expect(message).toContain("先跑 hr normalize a.html --write");
      expect(message).not.toContain(OBSOLETE);
    });
  });
});
