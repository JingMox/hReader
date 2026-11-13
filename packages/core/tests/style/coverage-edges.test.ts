// 这层管：覆盖率边角与门面——SVG 里的 `<style>`（非 raw text 子树）、摘录末尾、显式路径不带 id、
// `inherits_visual` 缺省、列表内的未知键、非字符串输入、以及 `src/style` 门面本身。

import { describe, expect, it } from "vitest";

import * as style from "../../src/style";
import { HrError } from "../../src/hr-error";
import { replaceTheme } from "../../src/style/apply";
import { lintByStyle } from "../../src/style/lint";
import { loadStyle } from "../../src/style/load";
import { parseStyleText } from "../../src/style/spec";
import { DEFAULT_STYLE_ID } from "../../src/style/presets";
import { builtinSeed, HOME, STYLE_YAML, styleEnv, THEME_CSS } from "./harness";

const EXPLICIT = `${HOME}/exports/my-style.yaml`;

const codeOfThrow = (run: () => unknown): string => {
  try {
    run();
    return "no_throw";
  } catch (error: unknown) {
    return error instanceof HrError ? error.code : "not_hr";
  }
};

describe("replaceTheme · SVG 里的 style 子树", () => {
  it("should replace the inner text of a non-raw-text <style> element", () => {
    const html =
      '<html><head></head><body><svg><style id="hr-theme"><g/></style></svg></body></html>';
    const result = replaceTheme(html, "a{color:red}");

    expect(result.changed).toBe(true);
    expect(result.html).toContain('<style id="hr-theme">a{color:red}</style>');
    expect(result.html).toContain("<svg>");
    expect(result.html.endsWith("</html>")).toBe(true);
  });
});

describe("lintByStyle · 摘录的末尾边界", () => {
  it("should not append an ellipsis when the hit reaches the block end", () => {
    const text = `${"前".repeat(40)}禁用`;
    const hit = lintByStyle([{ id: "n1", tag: "p", text, children: [] }], {
      forbidden: ["禁用"],
      recommended: [],
    }).hits[0];

    expect(hit?.excerpt.startsWith("…")).toBe(true);
    expect(hit?.excerpt.endsWith("禁用")).toBe(true);
    expect(hit?.excerpt.endsWith("…")).toBe(false);
  });
});

describe("lintByStyle · 同偏移并列", () => {
  it("should order hits that start at the same offset by vocabulary order", () => {
    const words = { forbidden: ["赋能", "赋能业务"], recommended: [] };
    const forward = lintByStyle([{ id: "n1", tag: "p", text: "赋能业务", children: [] }], words);
    const backward = lintByStyle([{ id: "n1", tag: "p", text: "赋能业务", children: [] }], {
      forbidden: ["赋能业务", "赋能"],
      recommended: [],
    });

    expect(forward.hits.map((hit) => hit.word)).toEqual(["赋能", "赋能业务"]);
    expect(backward.hits.map((hit) => hit.word)).toEqual(["赋能业务", "赋能"]);
  });
});

describe("loadStyle · 空输入", () => {
  it("should fall back to the default builtin when neither id nor path is given", async () => {
    const env = styleEnv(builtinSeed());
    const loaded = await loadStyle({}, env.deps);

    expect(loaded.source).toBe("builtin");
    expect(loaded.spec.id).toBe(DEFAULT_STYLE_ID);
  });
});

describe("loadStyle · 显式路径不带 id", () => {
  it("should accept an explicit path whose id matches the requested id", async () => {
    const env = styleEnv({
      [EXPLICIT]: STYLE_YAML("quiet", "显式"),
      [`${HOME}/exports/theme.css`]: THEME_CSS,
    });
    const loaded = await loadStyle({ id: "quiet", path: EXPLICIT }, env.deps);

    expect(loaded.source).toBe("explicit");
    expect(loaded.spec.id).toBe("quiet");
  });

  it("should load from an explicit path even when no id is requested", async () => {
    const env = styleEnv({
      [EXPLICIT]: STYLE_YAML("quiet", "显式"),
      [`${HOME}/exports/theme.css`]: THEME_CSS,
    });
    const loaded = await loadStyle({ path: EXPLICIT }, env.deps);

    expect(loaded.spec.id).toBe("quiet");
    expect(loaded.source).toBe("explicit");
    expect(loaded.themePath).toBe(`${HOME}/exports/theme.css`);
  });
});

describe("parseStyleText · 缺省与非法形状", () => {
  const MINIMAL = [
    "id: quiet",
    "name: 安静",
    "description: 少形容词。",
    "language_style:",
    "  persona: 短。",
    "  narrative_rules: 一句一个判断。",
    "  sentence_rhythm:",
    "    style: 短句为主。",
    "  vocabulary: {}",
    "",
  ].join("\n");

  it("should fall back to the default visual when inherits_visual is absent", () => {
    const spec = parseStyleText(MINIMAL, "spec.yaml");

    expect(spec.inheritsVisual).toBe("atelier-editorial");
  });

  it("should report an unknown key inside a list item without a key list hint", () => {
    const text = `id: quiet\nname: 安静\nlanguage_style:\n  narrative_rules:\n    - 规则\n      typo: 1\n`;

    expect(codeOfThrow(() => parseStyleText(text, "spec.yaml"))).toBe("invalid_style");
  });

  it("should map extreme nesting to invalid_style without crashing", () => {
    const hostile = `a: ${"[".repeat(50_000)}`;

    expect(codeOfThrow(() => parseStyleText(hostile, "spec.yaml"))).toBe("invalid_style");
  });

  it("should reject a list where a mapping is required", () => {
    expect(codeOfThrow(() => parseStyleText("- 1\n- 2\n", "spec.yaml"))).toBe("invalid_style");
  });
});

describe("src/style 门面", () => {
  it("should re-export the public surface and keep it callable", () => {
    expect(typeof style.applyStyle).toBe("function");
    expect(typeof style.replaceTheme).toBe("function");
    expect(typeof style.assertThemeSafe).toBe("function");
    expect(typeof style.compileTone).toBe("function");
    expect(typeof style.lintByStyle).toBe("function");
    expect(typeof style.loadStyle).toBe("function");
    expect(typeof style.discoverStyles).toBe("function");
    expect(typeof style.loadThemeCss).toBe("function");
    expect(typeof style.resolveThemePath).toBe("function");
    expect(typeof style.nodeStyleDeps).toBe("function");
    expect(style.LINT_HIT_LIMIT).toBe(100);
    expect(style.DEFAULT_STYLE_ID.length).toBeGreaterThan(0);
    expect(style.BUILTIN_STYLES.length).toBeGreaterThan(0);
    expect(style.findBuiltinStyle(style.DEFAULT_STYLE_ID)?.id).toBe(style.DEFAULT_STYLE_ID);
    expect(style.lintByStyle([], { forbidden: [], recommended: [] })).toEqual({
      hits: [],
      truncated: false,
    });
  });
});
