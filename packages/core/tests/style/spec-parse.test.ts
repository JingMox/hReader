// 这层管：`parseStyleText` 的映射与 YAML 敌意输入（锚点/重复键/制表符/未知标签），只验错误码与已映射字段。

import { describe, expect, it } from "vitest";

import type { StyleSpec } from "../../src/style/contracts";
import { HrError } from "../../src/hr-error";
import { parseStyleText } from "../../src/style/spec";
import { codeOf } from "../io/harness";

const FULL = [
  "id: quiet-clerk",
  "name: 安静的书记员",
  "description: 少形容词。",
  "inherits_visual: atelier-editorial",
  "language_style:",
  "  persona: 只说能核对的话。",
  "  narrative_rules:",
  "    - 一句话只放一个判断。",
  "    - 数字先于形容词。",
  "  sentence_rhythm:",
  "    max_paragraph_sentences: 2",
  "    style: 短句为主。",
  "  vocabulary:",
  "    forbidden:",
  "      - 赋能",
  "    recommended: [换句话说, 代价是]",
  "  examples:",
  "    - bad: 赋能业务。",
  "      good: 周转从 9 天降到 6 天。",
  "",
].join("\n");

const EXPECTED: StyleSpec = {
  id: "quiet-clerk",
  name: "安静的书记员",
  description: "少形容词。",
  inheritsVisual: "atelier-editorial",
  language: {
    persona: "只说能核对的话。",
    narrativeRules: ["一句话只放一个判断。", "数字先于形容词。"],
    rhythm: { maxParagraphSentences: 2, style: "短句为主。" },
    vocabulary: { forbidden: ["赋能"], recommended: ["换句话说", "代价是"] },
    examples: [{ bad: "赋能业务。", good: "周转从 9 天降到 6 天。" }],
  },
};

const codeIn = (text: string): string => codeOf(() => parseStyleText(text, "style.yaml"));

/** 报文断言需要整个错误对象（行号在 message 里，不在 code 里）。 */
const errorIn = (text: string): HrError => {
  try {
    parseStyleText(text, "style.yaml");
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("应该抛错但没有抛");
};

const MINIMAL = (extra: string): string =>
  [
    "id: s",
    "name: n",
    "description: d",
    "inherits_visual: t",
    "language_style:",
    "  persona: p",
    "  sentence_rhythm:",
    "    style: x",
    "  vocabulary: {}",
    extra,
  ].join("\n");

describe("parseStyleText · 合法输入", () => {
  it("should map every snake_case field onto the camelCase model", () => {
    expect(parseStyleText(FULL, "styles/quiet-clerk/style.yaml")).toEqual(EXPECTED);
  });

  it("should accept a single string wherever a list is allowed (成对构造：单值侧)", () => {
    const spec = parseStyleText(MINIMAL("  narrative_rules: 只说一句。"), "a.yaml");

    expect(spec.language.narrativeRules).toEqual(["只说一句。"]);
    expect(spec.language.vocabulary).toEqual({ forbidden: [], recommended: [] });
    expect(spec.language.examples).toEqual([]);
  });

  it("should default rhythm to 3 sentences and the unconstrained style sentinel", () => {
    const withoutRhythm = MINIMAL("  narrative_rules: [r]").replace(
      "  sentence_rhythm:\n    style: x\n",
      "",
    );

    expect(parseStyleText(withoutRhythm, "a.yaml").language.rhythm).toEqual({
      maxParagraphSentences: 3,
      style: "",
    });
    // 显式 `style: ''` 是同一个哨兵：合法且原样保留（裁定 R5）。
    expect(
      parseStyleText(MINIMAL("  narrative_rules: [r]").replace("style: x", "style: ''"), "a.yaml")
        .language.rhythm,
    ).toEqual({ maxParagraphSentences: 3, style: "" });
  });

  it("should strip a UTF-8 BOM and accept CRLF line endings", () => {
    const text = `\uFEFF${FULL.replaceAll("\n", "\r\n")}`;

    expect(parseStyleText(text, "crlf.yaml")).toEqual(EXPECTED);
  });
});

describe("parseStyleText · YAML 敌意输入", () => {
  it.each([
    ["锚点自引用炸弹", "language_style: &a\n  persona: p\n  narrative_rules: &b [*b]"],
    ["重复键", "id: a\nid: b"],
    ["制表符缩进", "id: s\n\tname: n"],
    ["未知标签 !!js/function", "persona: !!js/function > function(){}"],
    ["超深嵌套（400 层）", `${new Array(400).fill("a:").join(" ")} x`],
  ])("should reject %s with invalid_style", (_label, snippet) => {
    expect(codeIn(snippet)).toBe("invalid_style");
  });

  it("should document that a 4KB id passes the id regex (no length cap)", () => {
    const long = "a-b".repeat(1400);
    const spec = parseStyleText(
      MINIMAL("  narrative_rules: [r]").replace("id: s", `id: ${long}`),
      "a.yaml",
    );

    expect(spec.id).toBe(long);
  });
});

describe("parseStyleText · 语法错的行号（`lineAt` 前缀无换行的分支）", () => {
  it("should name line 1 when the syntax error is on the first line (no newline prefix)", () => {
    // 前缀没有换行时 `match(/\n/gu)` 返回 null → `?.length ?? 0` 走 0：
    // 只有单行 YAML 能覆盖这半边（其余用例全是多行）。
    const single = errorIn("id: [unclosed");

    expect(single.code).toBe("invalid_style");
    expect(single.message).toContain("第 1 行");
  });

  it("should count newlines for a syntax error on a later line", () => {
    expect(errorIn("id: s\nname: [unclosed").message).toContain("第 2 行");
    expect(errorIn("id: s\nname: n\nmood: [unclosed").message).toContain("第 3 行");
  });

  it("should keep reporting 第 1 行 for a single-line tab-indentation error", () => {
    expect(errorIn("\tid: s").message).toContain("第 1 行");
  });
});

describe("parseStyleText · 值形状", () => {
  it("should reject a value that is a scalar instead of a mapping", () => {
    expect(codeIn("just-a-string")).toBe("invalid_style");
    expect(codeIn("")).toBe("invalid_style");
  });

  it("should reject replacement characters leaked from non-UTF-8 bytes in id", () => {
    expect(codeIn(MINIMAL("  narrative_rules: [r]").replace("id: s", "id: s\uFFFD"))).toBe(
      "invalid_style",
    );
  });
});
