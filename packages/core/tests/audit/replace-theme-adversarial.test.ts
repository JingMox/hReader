// 这层管：`replaceTheme` 源码区间拼接的对抗边界——锚点伪装、模板内锚点、块外可疑字节不动。

import { describe, expect, it } from "vitest";

import { replaceTheme } from "../../src/style/apply";
import { HrError } from "../../src/hr-error";

const CSS = ".a{color:#1b1a17}";

describe("replaceTheme · 块外字节原样", () => {
  it("should leave an attribute value containing </style> untouched around the anchor", () => {
    const doc =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<style id="hr-theme">:root{--x:0}</style>` +
      `<link data-note="</style><script>"></head>` +
      `<body><p title="before </style> after">x</p></body></html>`;
    const result = replaceTheme(doc, CSS);

    // 拼接只发生在锚点 span：title/data-note 里的 </style> 文本一字节不动。
    expect(result.html).toContain(`data-note="</style><script>"`);
    expect(result.html).toContain(`title="before </style> after"`);
    expect(result.html).toContain(`<style id="hr-theme">${CSS}</style>`);
  });

  it("should not treat a style element with a lookalike id as the anchor", () => {
    const doc =
      `<!doctype html><html><head>` +
      `<style id="hr-theme2">.evil{color:red}</style>` +
      `<style data-hr-theme="hr-theme">.also{color:blue}</style>` +
      `<style id="hr-theme-x">.third{color:green}</style>` +
      `</head><body>x</body></html>`;
    const result = replaceTheme(doc, CSS);

    expect(result.html).toContain(".evil{color:red}");
    expect(result.html).toContain(".also{color:blue}");
    expect(result.html).toContain(".third{color:green}");
    expect(result.html).toContain(`<style id="hr-theme">${CSS}</style>`);
  });
});

describe("replaceTheme · 多锚点收敛", () => {
  it("should keep the first real anchor, delete later ones byte-wise, and not touch a template copy", () => {
    // template 里那份 style#hr-theme 是惰性内容：anchor 收集若看到它（span 有字节）会被删——
    // 记录现行行为：parse5 把 template 内容收进 content 片段，不在本树 children 里。
    const doc =
      `<!doctype html><html><head>` +
      `<style id="hr-theme">.old{a:1}</style>` +
      `<template><style id="hr-theme">.inTemplate{a:2}</style></template>` +
      `</head><body><style id="hr-theme">.inBody{a:3}</style></body></html>`;
    const result = replaceTheme(doc, CSS);

    expect(result.html).toContain(`<style id="hr-theme">${CSS}</style>`);
    expect(result.html).not.toContain(".inBody{a:3}");
    expect(result.html.match(/id="hr-theme"/gu)?.length).toBe(1);
  });

  it("should choose the head anchor when duplicates exist across head and body", () => {
    const doc =
      `<!doctype html><html><head><style id="hr-theme">.old{}</style></head>` +
      `<body><style id="hr-theme">.body{}</style><p>x</p></body></html>`;
    const result = replaceTheme(doc, CSS);

    // 首个锚点被替换、body 里那份整块删除，p 的位置字节不受影响。
    const styleIndex = result.html.indexOf(`<style id="hr-theme">${CSS}</style>`);
    expect(styleIndex).toBeGreaterThan(-1);
    expect(result.html).not.toContain(".body{}");
    expect(result.html.endsWith("<p>x</p></body></html>")).toBe(true);
  });
});

describe("replaceTheme · 拒绝带 </style 逃逸的主题 CSS", () => {
  it("should reject theme css containing a markup breakout attempt", () => {
    expect(() =>
      replaceTheme(
        `<!doctype html><html><head><style id="hr-theme">x</style></head><body/></html>`,
        `.a{color:red}</style><img src=x onerror=alert(1)>`,
      ),
    ).toThrowError(HrError);
  });

  it("should reject theme css containing </style even split across a comment", () => {
    // `assertThemeSafe` 直接禁 `<`：任何形式的转义/注释拆分都过不了 `<` 的硬禁。
    for (const css of [
      ".a{}</style><script>x</script>",
      ".a{}</sty\\6c e>",
      "/*</style>*/.a{}",
    ]) {
      expect(() =>
        replaceTheme(
          `<!doctype html><html><head><style id="hr-theme">x</style></head><body/></html>`,
          css,
        ),
      ).toThrowError(HrError);
    }
  });
});
