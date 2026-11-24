// 这层管：`parseStyleText` 的拒绝面——未知键（逐层）、id 逃逸、类型错误；每条都断 code 与出错位置。

import { describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import { parseStyleText } from "../../src/style/spec";

const BODY = [
  "  persona: 只说能核对的话。",
  "  narrative_rules: [一句话只放一个判断。]",
  "  sentence_rhythm:",
  "    max_paragraph_sentences: 2",
  "  vocabulary:",
  "    forbidden: [赋能]",
].join("\n");

const DOC = (languageBody: string = BODY, id = "quiet-clerk"): string =>
  [
    `id: ${id}`,
    "name: 安静的书记员",
    "description: 少形容词。",
    "inherits_visual: t",
    "language_style:",
    languageBody,
  ].join("\n");

const errorIn = (text: string): HrError => {
  try {
    parseStyleText(text, "style.yaml");
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("期望 invalid_style 但没有抛");
};

describe("parseStyleText · 未知键逐层拒绝", () => {
  const CASES: readonly (readonly [string, string, string])[] = [
    ["顶层", "render: x", "style.yaml.render"],
    ["language_style", `${BODY}\n  tone_style: x`, "language_style.tone_style"],
    [
      "sentence_rhythm",
      BODY.replace(
        "    max_paragraph_sentences: 2",
        "    max_paragraph_sentences: 2\n    cadence: x",
      ),
      "language_style.sentence_rhythm.cadence",
    ],
    [
      "vocabulary",
      BODY.replace("    forbidden: [赋能]", "    forbidden: [赋能]\n    banned: [x]"),
      "language_style.vocabulary.banned",
    ],
    [
      "examples[0]",
      `${BODY}\n  examples:\n    - bad: a\n      good: b\n      why: c`,
      "examples[0].why",
    ],
  ];

  it.each(CASES)(
    "should reject unknown key at %s with its location",
    (_level, languageBody, location) => {
      const error = errorIn(DOC(languageBody));

      expect(error.code).toBe("invalid_style");
      expect(error.message).toContain(location);
      expect(error.message).toContain("未知键");
    },
  );
});

const legalOf = (text: string): string => errorIn(text).message;

describe("parseStyleText · 未知键的提示按层列键集", () => {
  it("should list the document-root keys for an unknown root key", () => {
    const message = legalOf(`${DOC(BODY)}\nrender: x`);

    expect(message).toContain("style.yaml.render");
    expect(message).toContain("id、name、description、inherits_visual、language_style");
    expect(message).not.toContain("persona");
  });

  it("should list language_style keys for an unknown key in that layer", () => {
    const message = legalOf(DOC(`${BODY}\n  tone_style: x`));

    expect(message).toContain("language_style.tone_style");
    expect(message).toContain("persona、narrative_rules、sentence_rhythm、vocabulary、examples");
    expect(message).not.toContain("inherits_visual");
  });

  it("should list sentence_rhythm keys for an unknown key in that layer", () => {
    const message = legalOf(
      DOC(
        BODY.replace(
          "    max_paragraph_sentences: 2",
          "    max_paragraph_sentences: 2\n    cadence: x",
        ),
      ),
    );

    expect(message).toContain("language_style.sentence_rhythm.cadence");
    expect(message).toContain("max_paragraph_sentences、style");
  });
});

describe("parseStyleText · 深层的键集提示", () => {
  it("should list vocabulary keys and example-item keys for nested layers", () => {
    const vocabulary = legalOf(
      DOC(BODY.replace("    forbidden: [赋能]", "    forbidden: [赋能]\n    banned: [x]")),
    );
    const example = legalOf(DOC(`${BODY}\n  examples:\n    - bad: a\n      good: b\n      why: c`));

    expect(vocabulary).toContain("forbidden、recommended");
    expect(example).toContain("bad、good");
  });
});

describe("parseStyleText · id 逃逸与形状", () => {
  const withId = (id: string): string => DOC(BODY, id);

  it.each([
    ["父目录穿越", "../../etc/x"],
    ["单段穿越", ".."],
    ["绝对路径", "/tmp/x"],
    ["windows 分隔符", "a\\b"],
    ["NUL 字节", "a\u0000b"],
    ["大写", "Quiet"],
    ["下划线", "quiet_clerk"],
    ["前后空格", "' quiet '"],
    ["unicode 同形字", "ｑuiet"],
  ])("should reject %s as an id", (_label, id) => {
    expect(errorIn(withId(id)).code).toBe("invalid_style");
  });

  it("should reject a missing id and a whitespace-only name", () => {
    expect(errorIn(DOC().replace("id: quiet-clerk\n", "")).code).toBe("invalid_style");
    expect(errorIn(DOC().replace("name: 安静的书记员", "name: '   '")).code).toBe("invalid_style");
  });
});

describe("parseStyleText · 类型与列表边界", () => {
  it.each([
    ["rhythm 为 0", BODY.replace("2", "0")],
    ["rhythm 为负", BODY.replace("2", "-2")],
    ["rhythm 为小数", BODY.replace("2", "1.5")],
    ["narrative_rules 为空数组", BODY.replace("[一句话只放一个判断。]", "[]")],
    ["narrative_rules 混入非字符串", BODY.replace("[一句话只放一个判断。]", "[ok, 3]")],
    ["narrative_rules 是数字", BODY.replace("[一句话只放一个判断。]", "123")],
    ["examples 不是列表", `${BODY}\n  examples: {bad: a, good: b}`],
    ["examples 缺 good", `${BODY}\n  examples:\n    - bad: a`],
  ])("should reject %s with invalid_style", (_label, languageBody) => {
    expect(errorIn(DOC(languageBody)).code).toBe("invalid_style");
  });
});

describe("parseStyleText · 空集合与缺省块合法", () => {
  it.each([
    [
      "forbidden 空数组",
      BODY.replace("    forbidden: [赋能]", "    forbidden: []"),
      { forbidden: [], recommended: [] },
    ],
    [
      "recommended 空数组",
      `${BODY}\n    recommended: []`,
      { forbidden: ["赋能"], recommended: [] },
    ],
    [
      "两个列表都空",
      BODY.replace("    forbidden: [赋能]", "    forbidden: []\n    recommended: []"),
      { forbidden: [], recommended: [] },
    ],
  ])("should accept %s as「不约束」", (_label, languageBody, expected) => {
    const spec = parseStyleText(DOC(languageBody), "style.yaml");

    expect(spec.language.vocabulary).toEqual(expected);
  });

  it("should accept style: '' as the「不约束句式」哨兵", () => {
    const spec = parseStyleText(
      DOC(
        BODY.replace(
          "    max_paragraph_sentences: 2",
          "    max_paragraph_sentences: 2\n    style: ''",
        ),
      ),
      "style.yaml",
    );

    expect(spec.language.rhythm).toEqual({ maxParagraphSentences: 2, style: "" });
  });
});

describe("parseStyleText · 缺省块回落", () => {
  it("should fall back to 3 sentences and 0 forbidden words when blocks are absent", () => {
    const text = [
      "id: s",
      "name: n",
      "description: d",
      "language_style:",
      "  persona: p",
      "  narrative_rules: [r]",
    ].join("\n");
    const spec = parseStyleText(text, "style.yaml");

    expect(spec.language.rhythm).toEqual({ maxParagraphSentences: 3, style: "" });
    expect(spec.language.vocabulary).toEqual({ forbidden: [], recommended: [] });
    expect(spec.inheritsVisual).toBe("atelier-editorial");
  });
});

describe("parseStyleText · rhythm.style 的非字符串", () => {
  it.each([
    ["数字", "    style: 3"],
    ["布尔", "    style: true"],
    ["列表", "    style: [a, b]"],
  ])("should reject style: %s with invalid_style", (_label, injected) => {
    const languageBody = BODY.replace(
      "    max_paragraph_sentences: 2",
      `    max_paragraph_sentences: 2\n${injected}`,
    );

    expect(errorIn(DOC(languageBody)).code).toBe("invalid_style");
  });
});
