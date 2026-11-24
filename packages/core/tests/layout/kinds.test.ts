// 这层管：五种文档形态的起稿骨架——每一份都必须是合法文档、带齐 id、过得了排版检查。

import { describe, expect, it } from "vitest";

import { injectNodeIds } from "../../src/html/inject";
import { parseHtml } from "../../src/html/parse";
import { checkLayout } from "../../src/layout/check";
import { DEFAULT_DOC_KIND, DOC_KINDS, isDocKind, newDocumentHtml } from "../../src/layout/kinds";
import { validateDocument } from "../../src/model";
import { buildOutline } from "../../src/ops";

describe.each(DOC_KINDS)("newDocumentHtml · %s", (kind) => {
  const html = newDocumentHtml({ kind, title: "季度复盘" });
  const parsed = parseHtml(html);

  it("should be a valid document with no diagnostics", () => {
    expect(validateDocument(parsed)).toEqual([]);
  });

  it("should pass its own layout check", () => {
    expect(checkLayout(parsed.root)).toEqual([]);
  });

  it("should already carry every data-hr-id (nothing left for normalize)", () => {
    expect(injectNodeIds(parsed).injected).toEqual([]);
  });

  it("should record the kind on <article> and the title in <title> and <h1>", () => {
    expect(html).toContain(`<article data-hr-id="root" data-hr-kind="${kind}">`);
    expect(html).toContain("<title>季度复盘</title>");
    expect(buildOutline(parsed).nodes[0]?.text).toBe("季度复盘");
  });
});

describe("newDocumentHtml · 版心", () => {
  it("should centre reading kinds in .hr-layout and let slides fill the viewport", () => {
    expect(newDocumentHtml({ kind: "report", title: "t" })).toContain('<main class="hr-layout">');
    expect(newDocumentHtml({ kind: "slides", title: "t" })).not.toContain("hr-layout");
  });
});

describe("newDocumentHtml · 标题转义", () => {
  it("should escape markup characters in the title", () => {
    const html = newDocumentHtml({ kind: "note", title: "a<b>&c" });

    expect(html).toContain("<title>a&lt;b&gt;&amp;c</title>");
    expect(validateDocument(parseHtml(html))).toEqual([]);
  });
});

describe("文档形态词表", () => {
  it("should default to note", () => {
    expect(DEFAULT_DOC_KIND).toBe("note");
  });

  it("should recognise listed kinds only", () => {
    expect(isDocKind("slides")).toBe(true);
    expect(isDocKind("poster")).toBe(false);
  });
});
