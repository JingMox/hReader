// 这层管：`replaceTheme` 的源码区间拼接——只动 `<style id="hr-theme">` 内部，块外逐字节不动。

import { describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import { replaceTheme } from "../../src/style/apply";
import { codeOf } from "../io/harness";

const DOC = [
  '<!doctype html><html><head><meta charset="utf-8">',
  "<link rel=\"stylesheet\" href='./a.css'>",
  "</head><body>",
  "<p>周转 &nbsp; 9 天 → 6 天&mdash;&mdash;别动我。</p>",
  "</body></html>",
  "",
].join("\r\n");

const CSS = ":root{--hr-bg:#faf8f5}";

const errorOf = (run: () => unknown): HrError => {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("期望抛 HrError 但没有抛");
};

describe("replaceTheme · 注入（原文档没有主题块）", () => {
  it("should splice the style block into the end of <head> and keep every other byte", () => {
    const result = replaceTheme(DOC, CSS);
    const headEnd = DOC.indexOf("</head>");

    expect(result.changed).toBe(true);
    expect(result.html.slice(0, headEnd)).toBe(DOC.slice(0, headEnd));
    expect(result.html.slice(headEnd)).toBe(
      `<style id="hr-theme">${CSS}</style>${DOC.slice(headEnd)}`,
    );
    expect(result.html).toContain("<link rel=\"stylesheet\" href='./a.css'>");
    expect(result.html).toContain("周转 &nbsp; 9 天 → 6 天&mdash;&mdash;别动我。");
  });

  it("should use the implicit <head> the parser adds for a headless html", () => {
    const result = replaceTheme("<html><body><p>x</p></body></html>", CSS);

    expect(result.changed).toBe(true);
    expect(result.html).toContain(`<style id="hr-theme">${CSS}</style>`);
  });

  it("should reject an empty string (no head at all) with invalid_html", () => {
    const error = errorOf(() => replaceTheme("", CSS));
    expect(error.code).toBe("invalid_html");
    expect(error.message).toContain("head");
  });
});

const startedWithDoctype = (html: string, doctypeAtZero = true): string => {
  const result = replaceTheme(html, CSS);

  expect(result.changed).toBe(true);
  if (doctypeAtZero) expect(result.html.toLowerCase().startsWith("<!doctype")).toBe(true);
  return result.html;
};

describe("replaceTheme · 畸形文档的 doctype 不得被挤走", () => {
  it("should keep the doctype at byte 0 for a document with only <body>", () => {
    const out = startedWithDoctype("<!doctype html><body><p>x</p></body>");

    expect(out.indexOf("<!doctype")).toBe(0);
    expect(out.indexOf(`<head><style id="hr-theme">${CSS}</style></head>`)).toBeLessThan(
      out.indexOf("<body>"),
    );
  });

  it("should keep the doctype at byte 0 for a document with only <div>", () => {
    const out = startedWithDoctype("<!doctype html><div>x</div>");

    expect(out.indexOf("<!doctype")).toBe(0);
    expect(out).toContain(`<style id="hr-theme">${CSS}</style>`);
  });
});

describe("replaceTheme · doctype 与注释序", () => {
  it("should keep the doctype at byte 0 when the document is doctype-only", () => {
    const out = startedWithDoctype("<!doctype html>");

    expect(out.indexOf("<!doctype")).toBe(0);
    expect(out.slice(0, 15).toLowerCase()).toBe("<!doctype html>");
  });

  it("should preserve a comment + doctype prologue in place", () => {
    const out = startedWithDoctype("<!-- x --><!DOCTYPE html>\n<html><body>x</body></html>", false);

    expect(out.startsWith("<!-- x --><!DOCTYPE html>")).toBe(true);
    expect(out.toLowerCase().indexOf("<!doctype")).toBe("<!-- x -->".length);
    expect(out).toContain(`<style id="hr-theme">${CSS}</style>`);
  });

  it("should keep the doctype and inject into a headless <html>", () => {
    const out = startedWithDoctype("<!doctype html><html><body><p>x</p></body></html>");

    expect(out).toContain("<html><head>");
    expect(out).toContain("</head><body>");
  });

  it("should treat a comment-only document as an empty document , not a 0-byte one", () => {
    const out = replaceTheme("<!-- x -->", CSS).html;

    // 只有 doctype/注释的文档属合法“空文档”；0 字节才抛 invalid_html（见上一 describe）。
    expect(out.startsWith(`<head><style id="hr-theme">${CSS}</style></head>`)).toBe(true);
    expect(out).toContain("<!-- x -->");
  });

  it("should document the fragment case: no <head> in source, no doctype synthesized", () => {
    const out = replaceTheme("<div>x</div>", CSS).html;

    // 范围只保证“已有 doctype 不被挤走”；纯片段不合成 doctype。
    expect(out.startsWith("<head>")).toBe(true);
    expect(out).toContain(`<style id="hr-theme">${CSS}</style>`);
    expect(out).toContain("<div>x</div>");
  });
});

describe("replaceTheme · 替换（已有主题块）", () => {
  const WITH_BLOCK = DOC.replace(
    "</head>",
    '<style id="hr-theme" media="print">:root{--hr-bg:#000}</style>\r\n</head>',
  );

  it("should replace only the inner text and preserve the opening tag attributes", () => {
    const result = replaceTheme(WITH_BLOCK, CSS);

    expect(result.changed).toBe(true);
    expect(result.html).toContain(`<style id="hr-theme" media="print">${CSS}</style>`);
    expect(result.html).toContain("href='./a.css'");
    expect(DOC.length).toBeGreaterThan(0);
  });

  it("should report changed:false and byte-identical html when the css is already applied", () => {
    const once = replaceTheme(DOC, CSS).html;
    const twice = replaceTheme(once, CSS);

    expect(twice.changed).toBe(false);
    expect(twice.html).toBe(once);
  });

  it("should leave a non-matching <style> untouched", () => {
    const other = DOC.replace("</head>", '<style id="other">a{color:red}</style></head>');
    const result = replaceTheme(other, CSS);

    expect(result.html).toContain('<style id="other">a{color:red}</style>');
    expect(result.html).toContain(`<style id="hr-theme">${CSS}</style>`);
    expect(result.html.replace(`<style id="hr-theme">${CSS}</style>`, "")).toBe(other);
  });
});

describe("replaceTheme · 静态防线与解析模式", () => {
  it("should refuse unsafe css before touching the html", () => {
    const error = errorOf(() => replaceTheme(DOC, "@import 'x.css';"));

    expect(error.code).toBe("invalid_theme");
    expect(codeOf(() => replaceTheme(DOC, "body{background:url(http://evil/x.png)}"))).toBe(
      "invalid_theme",
    );
  });

  it("should find the block when id is not the first attribute", () => {
    const doc = DOC.replace(
      "</head>",
      '<style media="print" id="hr-theme">:root{--old:1}</style></head>',
    );

    expect(replaceTheme(doc, CSS).html).toContain(
      `<style media="print" id="hr-theme">${CSS}</style>`,
    );
  });

  it("should ignore a <style> without id and inject a fresh block", () => {
    const doc = DOC.replace("</head>", '<style media="print">a{color:red}</style></head>');

    expect(replaceTheme(doc, CSS).html).toContain('<style media="print">a{color:red}</style>');
    expect(replaceTheme(doc, CSS).html).toContain(`<style id="hr-theme">${CSS}</style>`);
  });
});

describe("replaceTheme · 单锚点收敛", () => {
  it("should collapse duplicate anchors to exactly one block", () => {
    const two = DOC.replace(
      "</head>",
      `<style id="hr-theme">a{}</style><style id="hr-theme">b{}</style></head>`,
    );
    const result = replaceTheme(two, CSS);

    expect(result.html.match(/id="hr-theme"/gu)?.length).toBe(1);
    expect(result.html).toContain(`<style id="hr-theme">${CSS}</style>`);
    expect(result.html).not.toContain("a{}");
    expect(result.html).not.toContain("b{}");
    expect(result.removed).toBe(1);
    // 块外字节不变：把主题块整段挖掉后应与原文一致。
    expect(result.html.replace(`<style id="hr-theme">${CSS}</style>`, "")).toBe(
      two.replace(`<style id="hr-theme">a{}</style><style id="hr-theme">b{}</style>`, ""),
    );
  });

  it("should report removed:0 when the anchor is unique", () => {
    const one = DOC.replace("</head>", `<style id="hr-theme">a{}</style></head>`);

    expect(replaceTheme(one, CSS).removed).toBe(0);
  });
});

describe("replaceTheme · 锚点身份与 prologue", () => {
  it("should not treat a non-style element carrying id=hr-theme as an anchor", () => {
    const doc = '<html><head></head><body><div id="hr-theme">x</div></body></html>';
    const result = replaceTheme(doc, CSS);

    expect(result.html).toContain('<div id="hr-theme">');
    expect(result.html).toContain(`<style id="hr-theme">${CSS}</style>`);
  });

  it("should keep a comment before the doctype ahead of the injected head", () => {
    const result = replaceTheme("<!-- note -->\n<!doctype html>\n<p>x</p>", CSS);
    const doctypeAt = result.html.indexOf("<!doctype");
    const headAt = result.html.indexOf("<head>");

    expect(result.html.startsWith("<!-- note -->")).toBe(true);
    expect(doctypeAt).toBeGreaterThan(0);
    expect(headAt).toBeGreaterThan(doctypeAt);
  });
});
