// R3-D1 ②（.workflow/cards/R3.md D1 表「双解释」+ docs/05:424）：同一个字面 `h2` 既能当标签名、
// 又能当某个元素（不是 `<h2>`）的 `data-hr-id` 时，CLI **不替你选**，报 `invalid_selector` +
// `data.reason:"ambiguous"`。这条测试要把三件事同时钉住：
// ① 报文承诺的三条逃路（`#id` / `[data-hr-id="x"]` / `父标签 > tag:nth-of-type(n)`）**各有一个能跑通的用例**
//    —— 不然"承诺"只是文案；
// ② `data` 的计数语义：`count` = 可寻址总数（截断不影响），`matches` = 选择器跳中的元素数（含不可寻址），
//    `candidates` = 文档序前 5 个；不变式 `candidates.length === Math.min(count, 5)`；
// ③ 被拒的 patch **一个字节都没写**（含 history/backup）。
//
// 断言钉外部可观察物：退出码、`--json` 信封 `data` 各字段、stdout 原文、落盘字节。

import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sha } from "./cli-support";
import { fieldOf, listOf, parseJsonLine, runCli, withTempDir } from "./harness";

/** core 的 `CANDIDATE_LIMIT`：报文只印前 5 个候选。 */
const CANDIDATE_LIMIT = 5;

const docWith = (body: string): string =>
  [
    "<!doctype html>",
    '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
    `<body data-hr-id="hr-body"><article data-hr-id="hr-root">${body}</article></body></html>`,
  ].join("\n");

/** 双解释语料：`<h2>` 有 id `hr-h2`，另有一个**不是** `<h2>` 的元素的 id 恰好是 `h2`。 */
const DUAL = docWith(
  ['<h2 data-hr-id="hr-h2">标题</h2>', '<div data-hr-id="h2">div 也叫 h2</div>'].join(""),
);

const liOf = (count: number): string =>
  `<ul data-hr-id="hr-ul">${Array.from(
    { length: count },
    (_unused, index) => `<li data-hr-id="hr-l${String(index + 1)}">第 ${String(index + 1)} 项</li>`,
  ).join("")}</ul>`;

interface Envelope {
  readonly code: number | null;
  readonly stdout: string;
  readonly parsed: unknown;
}

const run = async (dir: string, html: string, args: readonly string[]): Promise<Envelope> => {
  writeFileSync(`${dir}/a.html`, html);
  const result = await runCli([...args, "--json"], { cwd: dir });
  return { code: result.code, stdout: result.stdout, parsed: parseJsonLine(result.stdout) };
};

const dataOf = (parsed: unknown): unknown => fieldOf(parsed, "data");

const numberIn = (data: unknown, key: string): number => {
  const value = fieldOf(data, key);
  expect(typeof value).toBe("number");
  return Number(value);
};

const candidatesIn = (data: unknown): readonly unknown[] => listOf(fieldOf(data, "candidates"));

const htmlIn = (parsed: unknown): string => String(fieldOf(dataOf(parsed), "html"));

/** 不变式：候选列表恰好是"可寻址总数被上限截掉之后"剩下的那截。 */
const expectCandidateInvariant = (data: unknown): void => {
  expect(candidatesIn(data)).toHaveLength(Math.min(numberIn(data, "count"), CANDIDATE_LIMIT));
};

describe("D1 ② · 双解释拒绝（count = 可寻址总数，matches = 选择器命中数）", () => {
  it("should refuse `read h2` as ambiguous with count 2 / matches 1", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, DUAL, ["read", "a.html", "h2"]);

      expect(code).toBe(1);
      expect(fieldOf(parsed, "code")).toBe("invalid_selector");
      const data = dataOf(parsed);
      expect(fieldOf(data, "reason")).toBe("ambiguous");
      expect(numberIn(data, "count")).toBe(2);
      expect(numberIn(data, "matches")).toBe(1);
      expect(candidatesIn(data)).toEqual(["hr-h2", "h2"]);
      expectCandidateInvariant(data);
    });
  });

  it("should refuse `patch h2` as ambiguous and keep every byte", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUAL);
      const before = sha(`${dir}/a.html`);
      const result = await runCli(["patch", "a.html", "h2", "--action", "delete", "--json"], {
        cwd: dir,
      });
      const parsed = parseJsonLine(result.stdout);

      expect(result.code).toBe(1);
      expect(fieldOf(parsed, "code")).toBe("invalid_selector");
      expect(fieldOf(dataOf(parsed), "reason")).toBe("ambiguous");
      expect(numberIn(dataOf(parsed), "count")).toBe(2);
      expect(sha(`${dir}/a.html`)).toBe(before);
    });
  });
});

describe("D1 ② · 报文承诺的三条逃路各有一条能跑通", () => {
  it("should resolve `#h2` to the element whose id is h2, not the <h2> tag", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, DUAL, ["read", "a.html", "#h2"]);

      expect(code).toBe(0);
      expect(htmlIn(parsed)).toContain('data-hr-id="h2"');
      expect(htmlIn(parsed)).toContain("div 也叫 h2");
    });
  });

  it('should resolve `[data-hr-id="h2"]` to the attribute match', async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, DUAL, ["read", "a.html", '[data-hr-id="h2"]']);

      expect(code).toBe(0);
      expect(htmlIn(parsed)).toContain("div 也叫 h2");
    });
  });

  it("should resolve `article > h2:nth-of-type(1)` to the tag path", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, DUAL, [
        "read",
        "a.html",
        "article > h2:nth-of-type(1)",
      ]);

      expect(code).toBe(0);
      expect(htmlIn(parsed)).toContain('data-hr-id="hr-h2"');
      expect(htmlIn(parsed)).toContain("标题");
    });
  });
});

describe("D1 ② · 双解释报文自己把三条逃路都列出来", () => {
  it("should mention all three escape hatches in the ambiguous message", async () => {
    await withTempDir(async (dir) => {
      const { parsed } = await run(dir, DUAL, ["read", "a.html", "h2"]);
      const message = String(fieldOf(parsed, "message"));

      expect(message).toContain("'#h2'");
      expect(message).toContain('[data-hr-id="h2"]');
      expect(message).toContain(":nth-of-type(");
    });
  });
});

describe("D1 ② · 未截断时 count 与 candidates.length 相等", () => {
  it("should report count 3 / matches 3 when the 3 hits fit under the limit", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, docWith(liOf(3)), [
        "patch",
        "a.html",
        "li",
        "--action",
        "replace",
        "--html",
        "<li>x</li>",
      ]);

      expect(code).toBe(1);
      expect(fieldOf(parsed, "code")).toBe("invalid_selector");
      const data = dataOf(parsed);
      expect(fieldOf(data, "reason")).toBe("ambiguous");
      expect(numberIn(data, "count")).toBe(3);
      expect(numberIn(data, "matches")).toBe(3);
      expect(candidatesIn(data)).toHaveLength(3);
      expectCandidateInvariant(data);
    });
  });
});

describe("D1 ② · 截断时 count 保留总数、candidates 只剩 5 个", () => {
  it("should keep count 7 while truncating candidates to 5", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, docWith(liOf(7)), [
        "patch",
        "a.html",
        "li",
        "--action",
        "replace",
        "--html",
        "<li>x</li>",
      ]);

      expect(code).toBe(1);
      const data = dataOf(parsed);
      expect(numberIn(data, "count")).toBe(7);
      expect(numberIn(data, "matches")).toBe(7);
      expect(candidatesIn(data)).toHaveLength(CANDIDATE_LIMIT);
      // 未截断时 `count === candidates.length`，截断时两者不等：这条不变式才让 `count` 不是噪声。
      expectCandidateInvariant(data);
      expect(numberIn(data, "count")).toBeGreaterThan(candidatesIn(data).length);
    });
  });
});

describe("D1 ② · 撞名的标签：文档里真有 <li>，另有一个元素的 id 也是 li", () => {
  const CLI = docWith(
    [
      '<ul data-hr-id="hr-ul"><li data-hr-id="hr-l1">一</li></ul>',
      '<div data-hr-id="li">div 的 id 也叫 li</div>',
    ].join(""),
  );

  it("should refuse the bare `li` as ambiguous (count 2 / matches 1)", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, CLI, ["read", "a.html", "li"]);

      expect(code).toBe(1);
      expect(fieldOf(parsed, "code")).toBe("invalid_selector");
      const data = dataOf(parsed);
      expect(fieldOf(data, "reason")).toBe("ambiguous");
      expect(numberIn(data, "count")).toBe(2);
      expect(numberIn(data, "matches")).toBe(1);
      expectCandidateInvariant(data);
    });
  });

  it("should still let `#li` pick the element whose id is li", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, CLI, ["read", "a.html", "#li"]);

      expect(code).toBe(0);
      expect(htmlIn(parsed)).toContain("div 的 id 也叫 li");
    });
  });
});
