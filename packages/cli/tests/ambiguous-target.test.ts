// 这层管：多义/双解释目标——多个候选时报文给出 `reason/count/candidates`（文档序前 5 个），
// 同一字面既是标签名又是别人 id 时拒绝替你选（`reason:"ambiguous"`）并把三条逃路都列出来。

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checked, sha } from "./cli-support";
import { fieldOf, listOf, parseJsonLine, runCli, withTempDir } from "./harness";

/** 7 个 `<p>`，id 在文档里的出现顺序恰好是 `sort()` 升序的逆序。 */
const DOC_ORDER_IDS = ["hr-z", "hr-y", "hr-x", "hr-w", "hr-v", "hr-u", "hr-t"] as const;

const docWith = (body: string): string =>
  [
    "<!doctype html>",
    "<html><head><title>t</title></head><body>",
    `<article data-hr-id="hr-root"><section data-hr-id="hr-sec">${body}</section></article>`,
    "</body></html>",
  ].join("\n");

const paragraphsOf = (ids: readonly string[]): string =>
  ids.map((id, index) => `<p data-hr-id="${id}">第 ${String(index + 1)} 段</p>`).join("");

interface Refusal {
  readonly code: number | null;
  readonly codeField: unknown;
  readonly message: string;
  readonly data: unknown;
}

/** 跑一次必然失败的 `patch --json`：返回退出码与信封里要被断言的四个字段。 */
const refusalOf = async (dir: string, target: string): Promise<Refusal> => {
  const result = checked(
    await runCli(["patch", "a.html", target, "--action", "delete", "--json"], { cwd: dir }),
  );
  const envelope = parseJsonLine(result.stdout);
  return {
    code: result.code,
    codeField: fieldOf(envelope, "code"),
    message: String(fieldOf(envelope, "message")),
    data: fieldOf(envelope, "data"),
  };
};

const candidatesOf = (data: unknown): readonly unknown[] => listOf(fieldOf(data, "candidates"));
const countOf = (data: unknown): unknown => fieldOf(data, "count");

const DOC_ORDER_CANDIDATES = ["hr-z", "hr-y", "hr-x", "hr-w", "hr-v"] as const;

/**
 * 候选截断的核心判据：文档序前 5、且字典序前 5 **一个都不在**里面。
 * 后者是对 `.sort()` 变异的敏感点：两份前 5 在这份语料上无交集。
 */
const expectDocOrderCandidates = (data: unknown): void => {
  const candidates = candidatesOf(data);
  expect(candidates).toEqual(DOC_ORDER_CANDIDATES);
  expect(candidates).not.toEqual([...DOC_ORDER_IDS].sort().slice(0, 5));
  // 第 6、7 个（`hr-u`/`hr-t`）不进候选，但被 `count` 算进去。
  expect(candidates).not.toContain("hr-u");
  expect(candidates).not.toContain("hr-t");
  expect(countOf(data)).toBe(7);
};

/** 信封头部 + 人类报文（同一份候选、同一顺序，总量补在尾部）。 */
const expectAmbiguousEnvelope = (refused: Refusal): void => {
  expect(refused.code).toBe(1);
  expect(refused.codeField).toBe("invalid_selector");
  expect(fieldOf(refused.data, "reason")).toBe("ambiguous");
  expect(refused.message).toContain("命中 7 个可寻址元素");
  expect(refused.message).toContain("hr-z、hr-y、hr-x、hr-w、hr-v…等 7 个");
};

const expectDocOrderRefusal = (refused: Refusal): void => {
  expectAmbiguousEnvelope(refused);
  expectDocOrderCandidates(refused.data);
};

describe("patch · 多义报文的候选按文档序截断", () => {
  it("should list the first five candidates in document order, not in sorted order", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, docWith(paragraphsOf(DOC_ORDER_IDS)));
      const before = readFileSync(`${dir}/a.html`);

      expectDocOrderRefusal(await refusalOf(dir, "p"));
      // 拒答不动盘。
      expect(readFileSync(`${dir}/a.html`).equals(before)).toBe(true);
    });
  });

  it("should cap candidates at five but still count the sixth match", async () => {
    await withTempDir(async (dir) => {
      // `CANDIDATE_LIMIT + 1` 个命中：候选正好被截断一位，`count` 不受截断影响。
      writeFileSync(`${dir}/a.html`, docWith(paragraphsOf(DOC_ORDER_IDS.slice(0, 6))));

      const refused = await refusalOf(dir, "p");

      expect(candidatesOf(refused.data)).toEqual(DOC_ORDER_CANDIDATES);
      expect(countOf(refused.data)).toBe(6);
      expect(refused.message).toContain("…等 6 个");
    });
  });

  it("should not append the overflow hint when the count fits the candidate list", async () => {
    await withTempDir(async (dir) => {
      // 正好 5 个命中：候选全列出，末尾不许出现「…等」。
      writeFileSync(`${dir}/a.html`, docWith(paragraphsOf(DOC_ORDER_IDS.slice(0, 5))));

      const refused = await refusalOf(dir, "p");

      expect(candidatesOf(refused.data)).toEqual(DOC_ORDER_CANDIDATES);
      expect(countOf(refused.data)).toBe(5);
      expect(refused.message).not.toContain("…等");
    });
  });
});

describe("patch · 命中不可寻址元素", () => {
  it("should count 0 addressable for inline-only matches and refuse as node_not_found", async () => {
    await withTempDir(async (dir) => {
      // 三个 `<span>` 都没有 `data-hr-id`（行内元素不在 `ADDRESSABLE_TAGS` 里，规范化也不补）：
      // 命中数 3，可寻址数 0。若实现按「命中总数」判多义，这里会错报 `invalid_selector`。
      writeFileSync(
        `${dir}/a.html`,
        docWith('<p data-hr-id="hr-p">前<span>甲</span>中<span>乙</span>后<span>丙</span></p>'),
      );

      const refused = await refusalOf(dir, "span");

      expect(refused.code).toBe(1);
      expect(refused.codeField).toBe("node_not_found");
      expect(refused.message).toContain("不可寻址");
      expect(refused.message).not.toContain("invalid_selector");
    });
  });
});
/** core 的 `CANDIDATE_LIMIT`：报文只印前 5 个候选。 */
const CANDIDATE_LIMIT = 5;

const docWithIds = (body: string): string =>
  [
    "<!doctype html>",
    '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
    `<body data-hr-id="hr-body"><article data-hr-id="hr-root">${body}</article></body></html>`,
  ].join("\n");

/** 双解释语料：`<h2>` 有 id `hr-h2`，另有一个**不是** `<h2>` 的元素的 id 恰好是 `h2`。 */
const DUAL = docWithIds(
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

describe("双解释拒绝（count = 可寻址总数，matches = 选择器命中数）", () => {
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

describe("报文承诺的三条逃路各有一条能跑通", () => {
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

describe("双解释报文自己把三条逃路都列出来", () => {
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

describe("未截断时 count 与 candidates.length 相等", () => {
  it("should report count 3 / matches 3 when the 3 hits fit under the limit", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, docWithIds(liOf(3)), [
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

describe("截断时 count 保留总数、candidates 只剩 5 个", () => {
  it("should keep count 7 while truncating candidates to 5", async () => {
    await withTempDir(async (dir) => {
      const { code, parsed } = await run(dir, docWithIds(liOf(7)), [
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

describe("撞名的标签：文档里真有 <li>，另有一个元素的 id 也是 li", () => {
  const CLI = docWithIds(
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
