// 这层管：`assertThemeSafe` 的放行面——离线自足的主题必须全部通过（不能误杀）。

import { describe, expect, it } from "vitest";

import { assertThemeSafe } from "../../src/style/css";
import { codeOf } from "../io/harness";

const SAMPLE = [
  ":root{--hr-bg:#faf8f5}",
  "body{background:var(--hr-bg);color:#1b1a17}",
  ".hr-layout{display:grid;grid-template-columns:minmax(0,68ch) 280px}",
  'article a[href^="#"]{color:#8a4a22}',
  "",
].join("\n");

const codeFor = (css: string): string =>
  codeOf(() => {
    assertThemeSafe(css);
  });

describe("assertThemeSafe · 放行", () => {
  it("should accept static CSS with relative/data/anchor urls", () => {
    const css = [
      SAMPLE,
      ".a{background:url(./img/paper.png)}",
      ".b{background:url('../img/x.png')}",
      '.c{background:url("#top")}',
      ".d{background:url(data:image/png;base64,iVBORw0KGgo=)}",
      ".e{src:url(fonts/x.woff2) format('woff2')}",
      "",
    ].join("\n");

    expect(codeFor(css)).toBe("no_throw");
  });

  it("should treat same-origin absolute paths and root-relative urls as local", () => {
    expect(codeFor(".a{background:url(/assets/paper.png)}")).toBe("no_throw");
    expect(codeFor(".a{background:url('/assets/paper.png')}")).toBe("no_throw");
  });

  it.each([
    ["空样式表", ""],
    ["只有注释", "/* 离线主题，无外部依赖 */\n"],
    ["对比度注释里出现数字", "/* 16.42:1 */ :root{--hr-fg:#1b1a17}\n"],
    ["CSS 变量里出现 http 字样", ":root{--hr-note:'http is forbidden';--hr-x:1}\n"],
  ])("should accept %s", (_label, css) => {
    expect(codeFor(css)).toBe("no_throw");
  });

  it("should accept a relative path that merely contains a scheme-like substring", () => {
    expect(codeFor(".a{background:url(foo/data:.png)}")).toBe("no_throw");
    expect(codeFor(".a{background:url(dir/https:notes.png)}")).toBe("no_throw");
  });

  it("should accept an unclosed comment that swallows @import to EOF", () => {
    expect(codeFor("a{color:red}/* @import 'x.css';")).toBe("no_throw");
  });

  it("should accept the real builtin theme (仓库交付物)", async () => {
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(
      new URL("../../themes/atelier-editorial/theme.css", import.meta.url),
      "utf8",
    );

    expect(codeFor(css)).toBe("no_throw");
  });
});
