// R2-F18（docs/05:98 AC9 + docs/05:424 `invalid_selector` 表项）：多义报文的 `data`
// 契约是 `reason/count/candidates`，`candidates` 是**文档序**前 `CANDIDATE_LIMIT`（5）个
// `data-hr-id`，`count` 是命中的**可寻址**总数（不是候选数、不是命中元素总数）。
//
// 为什么非得自己造语料：仓库里既有语料的 id 顺序碰巧与字典序同向，于是「先收集再 `sort()`」
// 这种实现也能全绿。下面这份语料让文档序与 `sort()` 升序**完全相反**：
//   文档序：hr-z、hr-y、hr-x、hr-w、hr-v、hr-u、hr-t
//   字典序：hr-t、hr-u、hr-v、hr-w、hr-x、hr-y、hr-z
// 前 5 个候选因此在两种实现下必然不同（`hr-z…hr-v` vs `hr-t…hr-x`）。
//
// 断言钉外部可观察物：退出码、`--json` 信封、人类报文的候选串、以及文件字节不变。

import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
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

describe("patch · 多义报文的候选按文档序截断（F18 / docs/05:98）", () => {
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

describe("patch · 命中不可寻址元素（F18 / docs/05:98 末句）", () => {
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
