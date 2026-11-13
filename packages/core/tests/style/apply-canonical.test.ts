// 这层管：非规范锚点（大写 id）整块重写成规范形态（apply.ts 的 isCanonicalAnchor=false 臂）。

import { describe, expect, it } from "vitest";

import { replaceTheme } from "../../src/style/apply";

const CSS = ".a{color:#1b1a17}";

describe("replaceTheme · 非规范锚点的整块重写", () => {
  it("should canonicalize an uppercase id block and keep everything else", () => {
    const doc =
      '<!doctype html><html><head><style ID="HR-THEME">old{}</style></head><body>x</body></html>';
    const result = replaceTheme(doc, CSS);

    expect(result.html).toBe(
      `<!doctype html><html><head><style id="hr-theme">${CSS}</style></head><body>x</body></html>`,
    );
    expect(result.changed).toBe(true);
    expect(result.removed).toBe(0);
  });

  it("should be idempotent after canonicalization (second apply is byte-identical)", () => {
    const doc = '<html><head><style id="HR-THEME" media="print">old{}</style></head></html>';
    const first = replaceTheme(doc, CSS);
    const second = replaceTheme(first.html, CSS);

    expect(first.html).toContain(`<style id="hr-theme">${CSS}</style>`);
    expect(first.html).not.toContain('media="print"');
    expect(second.changed).toBe(false);
    expect(second.html).toBe(first.html);
  });
});
