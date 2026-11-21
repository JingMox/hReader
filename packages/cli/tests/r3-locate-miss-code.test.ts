// F20 / 结卡审计 BLOCKER-1（docs/05:424 `invalid_selector` 的 `reason` 两取值 + docs/05:120 AC1）：
// 两跳都没命中时，码由**这一跳为什么失败**（失败码）定，不由目标串长什么样定。
// 曾经的判据是 `HR_ID_PATTERN.test(target)`：`#`、空格、`>` 都不是 id 字符，于是"文法过了、只是零命中"
// 被塞进 syntax 分支——`hr read a.html '#S2'`（文档里只有 `s2`）报 `invalid_selector` + `reason:"syntax"`，
// 报文还自相矛盾地写着"没有匹配到任何节点"，而同一串走 core 的 `readNode` 是 `node_not_found`。
//
// 本文件钉两件事：
// ① 端到端（`spawn` 真 CLI，read 与 patch 两条命令）：六个字面的 `code` + `data.reason` + 报文首句，
//    每条都同时断言"拒绝发生在写盘之前，文件一个字节没动"；
// ② core 级：同一串 `locateTarget` 与 `readNode` **同码**——防的正是 F18 之后"CLI 报一个码、
//    core 报另一个码"的两层漂移（漂移时用户拿到的是自相矛盾的报文，且程序判定面 `code` 不可信）。
//    同码只在"两个入口对同一个串做同一件事"时才成立，所以裸 id `hr-NOPE` 单独一条用例写死那个**合理的**
//    不同：`locateTarget` 承认"裸 id 回退"（F1 的主路径），`readNode` 不是寻址器、只解析选择器文法。
//
// 断言钉外部可观察物：退出码、`--json` 信封（`code` / `data` 键集 / `data.reason` / `message`）、落盘字节。

import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HrError, locateTarget, parseHtml, readNode } from "@hreader/core";

import { checked, sha } from "./cli-support";
import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";

/** 文档里只有一个 id 为 `s2` 的小节：`#S2` 因此是"大写 id 查无此节点"，不是文法错。 */
const DOC = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  '<section data-hr-id="s2">小节</section>',
  '<p data-hr-id="hr-a1">正文</p>',
  "</article></body></html>",
].join("\n");

interface MissCase {
  readonly target: string;
  readonly code: "node_not_found" | "invalid_selector";
  /** `node_not_found` 时整个 `data` 键不出现，故为 `undefined`。 */
  readonly reason: "syntax" | undefined;
  /** 报文必须**逐字**这么开头：一句话，且主语是用户敲的那个串。 */
  readonly opens: string;
}

const MISSES: readonly MissCase[] = [
  {
    target: "#S2",
    code: "node_not_found",
    reason: undefined,
    opens: '文档里没有匹配 "#S2" 的节点。',
  },
  {
    target: "#nope",
    code: "node_not_found",
    reason: undefined,
    opens: '文档里没有匹配 "#nope" 的节点。',
  },
  {
    target: "article > div:nth-of-type(9)",
    code: "node_not_found",
    reason: undefined,
    opens: '文档里没有匹配 "article > div:nth-of-type(9)" 的节点。',
  },
  {
    target: "hr-NOPE",
    code: "node_not_found",
    reason: undefined,
    opens: '文档里没有 id 为 "hr-NOPE" 的节点。',
  },
  {
    target: "p[",
    code: "invalid_selector",
    reason: "syntax",
    opens: '选择器 "p[" 无法解析：',
  },
  { target: ">", code: "invalid_selector", reason: "syntax", opens: '选择器 ">" 无法解析：' },
];

interface Envelope {
  readonly code: number | null;
  readonly parsed: unknown;
}

const jsonRun = async (dir: string, args: readonly string[]): Promise<Envelope> => {
  const result = checked(await runCli([...args, "--json"], { cwd: dir }));
  return { code: result.code, parsed: parseJsonLine(result.stdout) };
};

/** 报文只有一句：不换行，也不把两跳的结论拼在一起。 */
const expectOneSentence = (message: string): void => {
  expect(message.includes("\n")).toBe(false);
  expect(message).not.toContain("按选择器");
  expect(message).not.toContain("按 node id");
};

const expectMiss = (result: Envelope, one: MissCase): void => {
  expect(result.code).toBe(1);
  expect(fieldOf(result.parsed, "code")).toBe(one.code);
  const message = String(fieldOf(result.parsed, "message"));
  expect(message.startsWith(one.opens)).toBe(true);
  expectOneSentence(message);
  if (one.reason === undefined) {
    // `data === undefined` 时整个键不出现：调用方按 `hasOwn` 分支，不用猜空对象。
    expect(keysOf(result.parsed)).toEqual(["ok", "code", "message"]);
    return;
  }
  expect(keysOf(result.parsed)).toEqual(["ok", "code", "message", "data"]);
  expect(fieldOf(fieldOf(result.parsed, "data"), "reason")).toBe(one.reason);
};

const seed = (dir: string): string => {
  const file = `${dir}/a.html`;
  writeFileSync(file, DOC);
  return file;
};

/** `read` 与 `patch` 共用同一条定位链：两条命令对同一个串必须给出同一个码，且都不许动文件。 */
const expectBothCommands = async (one: MissCase): Promise<void> => {
  await withTempDir(async (dir) => {
    const file = seed(dir);
    const before = sha(file);

    expectMiss(await jsonRun(dir, ["read", "a.html", one.target]), one);
    expect(sha(file)).toBe(before);

    expectMiss(await jsonRun(dir, ["patch", "a.html", one.target, "--action", "delete"]), one);
    expect(sha(file)).toBe(before);
    expect(readFileSync(file, "utf8")).toBe(DOC);
  });
};

describe("F20 · 两跳都没命中时码由失败码定，不由目标串形态定", () => {
  it.each(MISSES)("should report $code for target $target", expectBothCommands);
});

/** 只取 `code`：非 `HrError` 一律重新抛出（那是内部错，不该被当成用户错断言）。 */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error.code;
    throw error;
  }
  throw new Error("期望失败，但成功了");
};

describe("F20 · 同一串 locateTarget 与 readNode 必须同码（防 F18 之后的两层漂移）", () => {
  const parsed = parseHtml(DOC);
  /** `hr-NOPE` 除外：它是裸 id，两个入口对它做的事本来就不同（见下一条用例）。 */
  const SHARED = MISSES.filter((one) => one.target !== "hr-NOPE");

  it.each(SHARED)("should agree on the code for $target", (one) => {
    const located = codeOf(() => locateTarget(parsed, one.target));
    const read = codeOf(() => readNode(parsed, one.target));

    expect(located).toBe(one.code);
    expect(read).toBe(located);
  });

  it("should diverge on a bare id: locateTarget falls back, readNode does not", () => {
    // `hr-NOPE` 符合 `HR_ID_PATTERN`，所以 locateTarget 会走第二跳（裸 id 回退，F1 的主路径）；
    // `readNode` 只是选择器求值器，`hr-NOPE` 在它那里是文法错。两边"不同码"是对的——
    // 硬要一致就得让 readNode 偷偷实现回退，那才是把两条数据流塞回一个函数。
    expect(codeOf(() => locateTarget(parsed, "hr-NOPE"))).toBe("node_not_found");
    expect(codeOf(() => readNode(parsed, "hr-NOPE"))).toBe("invalid_selector");
    expect(codeOf(() => readNode(parsed, '[data-hr-id="hr-NOPE"]'))).toBe("node_not_found");
  });
});
