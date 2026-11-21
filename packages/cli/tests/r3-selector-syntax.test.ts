// R3-D1（.workflow/cards/R3.md D1 表 + docs/05:424 `invalid_selector` 的 `reason` 两取值）：
// ① 选择器**文法错**与"跳不到节点"是两个码：`p[` / `p[0]` / `a b` / `*` / `div>p` 一律
//    `invalid_selector` + `data.reason:"syntax"`（退出 1），不再按"含不含引号"猜；
// ② 裸 id 靠**回退链**成功——本卡最大风险：`hr-a1` 在 `parseSelector` 里本身就是文法错
//    （标签名不许带 `-`），把文法错一律判 syntax 会把裸 id 一起打死；
// ③ 只有"文法合法但查无此 id"的裸 id 才是 `node_not_found`，且 JSON 错误信封**没有 `data` 键**；
// ④ 人读报文**只有一句**：不出"按选择器 → …；按 node id → …"的双跳拼接。
//
// 断言钉外部可观察物：退出码、`--json` 信封（`code` / `data.reason` / 键集）、stdout 原文、落盘字节。

import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { sha } from "./cli-support";
import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";

const DOC = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  '<h2 data-hr-id="hr-h2">标题</h2>',
  '<p data-hr-id="hr-a1">正文</p>',
  "</article></body></html>",
].join("\n");

/** D1 表左列：五个"看起来像选择器、文法却不合法"的字面，外加一个以 `"` 开头的字面。 */
const SYNTAX_SELECTORS = ["p[", "p[0]", "a b", "*", "div>p", '"hr-a1"'] as const;

const seed = (dir: string): string => {
  const file = `${dir}/a.html`;
  writeFileSync(file, DOC);
  return file;
};

interface Envelope {
  readonly code: number | null;
  readonly stdout: string;
  readonly parsed: unknown;
}

const jsonRun = async (dir: string, args: readonly string[]): Promise<Envelope> => {
  const result = await runCli([...args, "--json"], { cwd: dir });
  return { code: result.code, stdout: result.stdout, parsed: parseJsonLine(result.stdout) };
};

const codeOf = (parsed: unknown): unknown => fieldOf(parsed, "code");

const messageOf = (parsed: unknown): string => String(fieldOf(parsed, "message"));

/** "只有一句"的可检查形态：单行、且没有把两次跳转的结论拼在一起。 */
const expectOneHopMessage = (message: string): void => {
  expect(message.includes("\n")).toBe(false);
  expect(message).not.toContain("按选择器");
  expect(message).not.toContain("按 node id");
  expect(message).not.toContain("只会命中第一个");
};

describe("D1 · 文法错的选择器在 read 时一律 invalid_selector + reason:syntax", () => {
  it.each(SYNTAX_SELECTORS)(
    "should refuse read target %s as invalid_selector/syntax",
    async (target) => {
      await withTempDir(async (dir) => {
        seed(dir);
        const { code, parsed } = await jsonRun(dir, ["read", "a.html", target]);

        expect(code).toBe(1);
        expect(codeOf(parsed)).toBe("invalid_selector");
        expect(fieldOf(fieldOf(parsed, "data"), "reason")).toBe("syntax");
        const message = messageOf(parsed);
        expect(message).toContain("无法解析");
        // 报文按 JSON 字面回显目标：带 `"` 的目标在那里是转义形态。
        expect(message).toContain(target.replaceAll('"', '\\"'));
        expectOneHopMessage(message);
      });
    },
  );
});

describe("D1 · 文法错的选择器在 patch 时一律 invalid_selector + reason:syntax", () => {
  it.each(SYNTAX_SELECTORS)(
    "should refuse patch target %s as invalid_selector/syntax",
    async (target) => {
      await withTempDir(async (dir) => {
        const file = seed(dir);
        const before = sha(file);
        const { code, parsed } = await jsonRun(dir, [
          "patch",
          "a.html",
          target,
          "--action",
          "delete",
        ]);

        expect(code).toBe(1);
        expect(codeOf(parsed)).toBe("invalid_selector");
        expect(fieldOf(fieldOf(parsed, "data"), "reason")).toBe("syntax");
        expectOneHopMessage(messageOf(parsed));
        // 拒绝发生在写盘之前：原字节必须一字不动（含 backup/history）。
        expect(sha(file)).toBe(before);
      });
    },
  );
});

describe("D1 · 裸 id 不被新逻辑误伤：存在的裸 id 仍可 read 与 patch", () => {
  it("should still read a bare id that is itself a parseSelector syntax error", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const { code, parsed } = await jsonRun(dir, ["read", "a.html", "hr-a1"]);

      expect(code).toBe(0);
      expect(fieldOf(parsed, "ok")).toBe(true);
      expect(String(fieldOf(fieldOf(parsed, "data"), "html"))).toContain('data-hr-id="hr-a1"');
    });
  });

  it("should still patch a bare id that is itself a parseSelector syntax error", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir);
      const { code, parsed } = await jsonRun(dir, [
        "patch",
        "a.html",
        "hr-a1",
        "--action",
        "replace",
        "--html",
        '<p data-hr-id="hr-a1">改过了</p>',
      ]);

      expect(code).toBe(0);
      expect(fieldOf(fieldOf(parsed, "data"), "changed")).toBe(true);
      expect(String(fieldOf(fieldOf(parsed, "data"), "path"))).toBe(file);
    });
  });
});

describe("D1 · 文法合法但查无此 id 的裸 id 才报 node_not_found", () => {
  it("should report an absent bare id as node_not_found without a data key", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const { code, parsed } = await jsonRun(dir, ["read", "a.html", "hr-nope"]);

      expect(code).toBe(1);
      expect(codeOf(parsed)).toBe("node_not_found");
      expect(keysOf(parsed)).toEqual(["ok", "code", "message"]);
      expect(messageOf(parsed)).toContain('"hr-nope"');
      expectOneHopMessage(messageOf(parsed));
    });
  });
});

describe("D1 · 人读报文是单跳（不拼两套解释）", () => {
  it("should print one hop for a syntax error in human mode", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(["read", "a.html", "p["], { cwd: dir });
      const lines = result.stdout.trimEnd().split("\n");

      expect(result.code).toBe(1);
      expect(lines).toHaveLength(1);
      expectOneHopMessage(lines[0] ?? "");
    });
  });

  it("should print one hop for an absent bare id in human mode", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(["read", "a.html", "hr-nope"], { cwd: dir });
      const lines = result.stdout.trimEnd().split("\n");

      expect(result.code).toBe(1);
      expect(lines).toHaveLength(1);
      expectOneHopMessage(lines[0] ?? "");
    });
  });
});

describe("D1 · 空 <article> 仍走两条路（不因没内容而改码）", () => {
  const EMPTY = [
    "<!doctype html>",
    '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
    '<body data-hr-id="hr-body"><article data-hr-id="hr-root"></article></body></html>',
  ].join("\n");

  it("should read the empty article itself", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, EMPTY);
      const { code, parsed } = await jsonRun(dir, ["read", "a.html", "hr-root"]);

      expect(code).toBe(0);
      expect(String(fieldOf(fieldOf(parsed, "data"), "html"))).toBe(
        '<article data-hr-id="hr-root"></article>',
      );
      expect(fieldOf(fieldOf(parsed, "data"), "truncated")).toBe(false);
    });
  });

  it("should report a tag selector with no match as node_not_found (its literal is a legal id)", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, EMPTY);
      const { code, parsed } = await jsonRun(dir, ["read", "a.html", "div"]);

      expect(code).toBe(1);
      expect(codeOf(parsed)).toBe("node_not_found");
      expect(messageOf(parsed)).toContain('"div"');
    });
  });
});
