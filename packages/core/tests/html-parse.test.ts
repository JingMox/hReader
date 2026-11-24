import { describe, expect, it } from "vitest";

import { HrError, parseHtml } from "../src/index";
import type { ParsedHtml } from "../src/index";
import {
  attributeValue,
  callWithUnknown,
  catchThrown,
  childrenOf,
  codesOf,
  messagesOf,
  requireElement,
} from "./html-support";

const COMPONENTS = [
  "kpi-bento",
  "callout-insight",
  "callout-warning",
  "split-compare",
  "deep-dive",
  "step-timeline",
  "diagram-stage",
];

const NON_STRING_INPUTS: readonly unknown[] = [
  42,
  0,
  null,
  undefined,
  {},
  ["<p>"],
  true,
  Symbol("x"),
];

describe("parseHtml · 边界输入", () => {
  it("should return an empty document for the empty string", () => {
    const parsed = parseHtml("");

    expect(parsed.root).toEqual({ kind: "document", children: [] });
    expect(codesOf(parsed)).toEqual(["empty_document"]);
  });

  it("should treat whitespace-only input as an empty document", () => {
    const parsed = parseHtml(" \n\t\r ");

    expect(parsed.root).toEqual({ kind: "document", children: [] });
    expect(codesOf(parsed)).toEqual(["empty_document"]);
  });

  it("should surface non-string input as HrError invalid_html (not a diagnostic)", () => {
    for (const input of NON_STRING_INPUTS) {
      const error = catchThrown(() => {
        callWithUnknown(parseHtml, input);
      });
      expect(error).toBeInstanceOf(HrError);
      if (!(error instanceof HrError)) {
        throw new Error("expected HrError");
      }
      expect(error.code).toBe("invalid_html");
      expect(error.name).toBe("HrError");
    }
  });
});

describe("parseHtml · 结构", () => {
  it("should place doctype first and comment/text inside the html skeleton", () => {
    const parsed = parseHtml("<!DOCTYPE html><body><!--c-->hi");

    expect(childrenOf(parsed.root)[0]).toEqual({
      kind: "doctype",
      name: "html",
      publicId: "",
      systemId: "",
    });
    expect(requireElement(parsed.root, "body").children).toEqual([
      { kind: "comment", data: "c" },
      { kind: "text", value: "hi" },
    ]);
  });

  it("should keep doctype public/system identifiers", () => {
    const parsed = parseHtml(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">',
    );

    expect(childrenOf(parsed.root)[0]).toEqual({
      kind: "doctype",
      name: "html",
      publicId: "-//W3C//DTD HTML 4.01//EN",
      systemId: "http://www.w3.org/TR/html4/strict.dtd",
    });
  });

  it("should keep a system-only doctype's publicId empty", () => {
    const parsed = parseHtml('<!DOCTYPE html SYSTEM "about:legacy-compat">');

    expect(childrenOf(parsed.root)[0]).toEqual({
      kind: "doctype",
      name: "html",
      publicId: "",
      systemId: "about:legacy-compat",
    });
  });
});

describe("parseHtml · 标签与子树", () => {
  it("should lowercase tag and attribute names while preserving attribute order", () => {
    const element = requireElement(parseHtml('<DIV B="2" a="1" C>x</DIV>').root, "div");

    expect(element.tag).toBe("div");
    expect(element.attrs).toEqual([
      ["b", "2"],
      ["a", "1"],
      ["c", ""],
    ]);
  });

  it("should keep only the first value of a duplicated attribute and report it", () => {
    const parsed = parseHtml('<div z="1" A="2" z="3">x</div>');
    const element = requireElement(parsed.root, "div");

    expect(element.attrs).toEqual([
      ["z", "1"],
      ["a", "2"],
    ]);
    expect(codesOf(parsed)).toContain("duplicate_attribute");
  });

  it("should keep script raw text verbatim as a single text child", () => {
    const source = 'if (a<b) { x = "<div>"; }';
    const script = requireElement(parseHtml(`<script>${source}</script>`).root, "script");

    expect(script.children).toEqual([{ kind: "text", value: source }]);
  });
});

describe("parseHtml · 模板与空元素", () => {
  it("should keep template content instead of dropping the subtree", () => {
    const template = requireElement(parseHtml("<template><p>t</p></template>").root, "template");

    expect(template.children).toHaveLength(1);
    expect(requireElement(template, "p").children).toEqual([{ kind: "text", value: "t" }]);
  });

  it("should give void elements no children", () => {
    const parsed = parseHtml("<p>a<br>b</p>");
    const br = requireElement(parsed.root, "br");

    expect(br.children).toEqual([]);
  });
});

describe("parseHtml · 组件白名单", () => {
  it("should accept every one of the seven whitelisted component values", () => {
    for (const component of COMPONENTS) {
      const parsed = parseHtml(`<div data-hr-component="${component}">x</div>`);
      expect(codesOf(parsed)).toEqual([]);
      expect(attributeValue(requireElement(parsed.root, "div"), "data-hr-component")).toBe(
        component,
      );
    }
  });

  it("should keep an unlisted component's attributes and report invalid_component", () => {
    const parsed = parseHtml('<div data-hr-component="bento-grid">x</div>');
    const div = requireElement(parsed.root, "div");

    expect(attributeValue(div, "data-hr-component")).toBe("bento-grid");
    expect(codesOf(parsed)).toEqual(["invalid_component"]);
    expect(parsed.diagnostics[0]?.path).toContain("div[0]");
  });

  it("should not report anything for a div without the component attribute", () => {
    expect(codesOf(parseHtml('<div class="a">x</div>'))).toEqual([]);
  });
});

describe("parseHtml · 诊断形状", () => {
  it("should attach no path to tokenizer-level diagnostics (EOF inside a tag)", () => {
    const parsed = parseHtml("<div class='a'");

    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]?.code).toBe("unclosed_tag");
    expect(parsed.diagnostics[0]?.severity).toBe("warning");
    expect(messagesOf(parsed)[0]).toContain("eof-in-tag");
    expect(parsed.diagnostics[0] !== undefined && "path" in parsed.diagnostics[0]).toBe(false);
  });

  it("should drop parse5 error codes that have no diagnostic mapping", () => {
    // missing-doctype 是唯一一个 parse5 会上报但本层故意不映射的错误码。
    expect(codesOf(parseHtml("<p>x</p>"))).toEqual([]);
  });

  it("should map an end tag carrying attributes to misnested_tag", () => {
    expect(codesOf(parseHtml('<div>x</div class="x">'))).toContain("misnested_tag");
  });
});

const isDocumentRoot = (parsed: ParsedHtml): boolean => parsed.root.kind === "document";

describe("parseHtml · 深文档", () => {
  it("should parse 10k-deep nesting without a RangeError", () => {
    const depth = 10_000;
    const html = `${"<section>".repeat(depth)}x${"</section>".repeat(depth)}`;
    const parsed = parseHtml(html);

    expect(isDocumentRoot(parsed)).toBe(true);
    expect(codesOf(parsed)).toEqual([]);
  });
});
