// R2-F18（docs/05:98 AC9「5 种 action 都可寻址」+ docs/05:424 `invalid_selector` 的 `reason` 两个取值
// + docs/05:120 AC1「`hr read <file> <nodeId|selector>`」）：
// ① 五种 action 都能用**选择器**（不是 id）当目标，落盘后内容真的按该语义变了；
// ② 两跳都失败时按目标字面形态定码：含 `"` → `invalid_selector` + `data.reason:"syntax"`，
//    不含 → `node_not_found` 且**没有** `data` 键（JSON 错误信封的 `data === undefined` 分支）；
// ③ 空大纲的端到端提示：两行原文，第二行可照抄（路径是 cwd 相对）。
//
// 断言钉外部可观察物：退出码、`--json` 信封、落盘字节、stdout 原文。

import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";

const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-root"><section data-hr-id="hr-sec">',
  '<p data-hr-id="hr-p">正文</p>',
  '<ul data-hr-id="hr-u"><li data-hr-id="hr-l1">一</li></ul>',
  '<table data-hr-id="hr-tb"><tbody data-hr-id="hr-tby">',
  '<tr data-hr-id="hr-tr1"><td data-hr-id="hr-td1">格</td></tr>',
  "</tbody></table>",
  "</section></article>",
  "</body></html>",
].join("\n");

/** 无标题文档：`<article>` 在、可读文本在，但没有任何 `<h1>`–`<h6>`。 */
const UNTITLED = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-root"><p data-hr-id="hr-p">正文</p></article>',
  "</body></html>",
].join("\n");

const seed = (dir: string, name = "a.html", html = DOC): string => {
  const file = `${dir}/${name}`;
  writeFileSync(file, html);
  return file;
};

/** 跑一条 `patch --json`，返回退出码与信封（两种结局共用）。 */
const patchJson = async (
  dir: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly envelope: unknown }> => {
  const result = checked(await runCli(["patch", "a.html", ...args, "--json"], { cwd: dir }));
  return { code: result.code, envelope: parseJsonLine(result.stdout) };
};

interface ActionCase {
  readonly action: string;
  /** 选择器目标：单匹配（多义口径由 `r2-ambiguous-candidates.test.ts` 钉）。 */
  readonly target: string;
  readonly html: string | undefined;
  /** 落盘后必须出现 / 必须消失的片段。 */
  readonly present: readonly string[];
  readonly absent: readonly string[];
}

const ACTIONS: readonly ActionCase[] = [
  {
    action: "replace",
    target: "ul",
    html: "<ul><li>换掉</li></ul>",
    present: ['<ul data-hr-id="hr-u"><li data-hr-id'],
    absent: ["一</li>"],
  },
  {
    action: "insert_before",
    target: "ul",
    html: "<p>前插</p>",
    present: ["前插", '<ul data-hr-id="hr-u">'],
    absent: [],
  },
  {
    action: "insert_after",
    target: "ul",
    html: "<p>后插</p>",
    present: ["后插"],
    absent: [],
  },
  {
    action: "append",
    target: "ul",
    html: "<li>追加</li>",
    present: ["追加</li>"],
    absent: [],
  },
  {
    action: "delete",
    target: "table",
    html: undefined,
    present: ['<p data-hr-id="hr-p">正文</p>'],
    absent: ["<table"],
  },
];

const patchArgsOf = (one: ActionCase): readonly string[] =>
  one.html === undefined
    ? [one.target, "--action", one.action]
    : [one.target, "--action", one.action, "--html", one.html];

describe("patch · 五种 action 都能用选择器定位（F18 / docs/05:98）", () => {
  it.each(ACTIONS)("should apply $action to a selector-addressed target", async (one) => {
    await withTempDir(async (dir) => {
      const file = seed(dir);

      const { code, envelope } = await patchJson(dir, patchArgsOf(one));

      expect(code).toBe(0);
      expect(fieldOf(envelope, "ok")).toBe(true);
      const after = readFileSync(file, "utf8");
      for (const needle of one.present) expect(after).toContain(needle);
      for (const needle of one.absent) expect(after).not.toContain(needle);
      // 五种 action 都不许动文档根。
      expect(after).toContain('<article data-hr-id="hr-root">');
    });
  });
});

describe("patch · 两跳都失败时的码与 `data`（F18 / docs/05:424）", () => {
  it("should report invalid_selector with reason `syntax` when the target breaks the attribute quoting", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir);
      const before = readFileSync(file);

      const { code, envelope } = await patchJson(dir, ['a"b', "--action", "delete"]);

      expect(code).toBe(1);
      expect(fieldOf(envelope, "code")).toBe("invalid_selector");
      // 唯一能让 `[data-hr-id="…"]` 本身非法的形态：`"`/`\`/换行。码在这里反过来（不是 node_not_found）。
      expect(fieldOf(fieldOf(envelope, "data"), "reason")).toBe("syntax");
      // F19 起报文只有一句：目标不是合规 id（`"` 让 `[data-hr-id="…"]` 本身非法），报 syntax 那一句。
      expect(String(fieldOf(envelope, "message"))).toContain('选择器 "a\\"b" 无法解析：');
      expect(readFileSync(file).equals(before)).toBe(true);
    });
  });

  it("should report node_not_found and omit the `data` key for a plain miss", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      const { code, envelope } = await patchJson(dir, ["hr-nope", "--action", "delete"]);

      expect(code).toBe(1);
      expect(fieldOf(envelope, "code")).toBe("node_not_found");
      // `data === undefined` 时整个键不出现：调用方按 `hasOwn` 分支，不用猜空对象。
      expect(keysOf(envelope)).toEqual(["ok", "code", "message"]);
    });
  });
});

describe("outline · 无标题文档的端到端提示（docs/05:120）", () => {
  it("should print the two-line hint with the cwd-relative path, exit 0", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "a.html", UNTITLED);

      const result = checked(await runCli(["outline", "a.html"], { cwd: dir }));

      expect(result.code).toBe(0);
      // 两行原文：第二行必须能照抄执行，所以路径按用户视角（cwd 相对），不是临时目录绝对路径。
      expect(result.stdout).toBe(
        "（没有标题）\n本文没有标题；用 hr read a.html <nodeId|selector> 取内容\n",
      );
      expect(result.stdout).not.toContain(dir);
    });
  });
});
