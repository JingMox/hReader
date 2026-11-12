import { describe, expect, it } from "vitest";

import { parseHtml, serializeHtml } from "../src/index";
import type { HtmlNode, ParsedHtml } from "../src/index";

const EMPTY_BODY = "<html><head></head><body></body></html>";
const FULL = (inner: string): string =>
  `<!DOCTYPE html><html><head></head><body>${inner}</body></html>`;

const roundPrint = (html: string): string => serializeHtml(parseHtml(html));

const fromRoot = (root: HtmlNode): ParsedHtml => ({ root, diagnostics: [] });

describe("serializeHtml · 转义与 raw text", () => {
  it("should escape & < > in text but leave quotes alone", () => {
    expect(roundPrint(FULL("<p>a &amp; b &lt; c &gt; \"d\" 'e'</p>"))).toBe(
      FULL("<p>a &amp; b &lt; c &gt; \"d\" 'e'</p>"),
    );
  });

  it('should escape & and " in attribute values only', () => {
    expect(roundPrint(FULL(`<div title='a"b&c<d>e'>x</div>`))).toBe(
      FULL('<div title="a&quot;b&amp;c<d>e">x</div>'),
    );
  });

  it("should keep nbsp as a literal character instead of re-encoding it", () => {
    expect(roundPrint(FULL("<p>&nbsp;</p>"))).toBe(FULL("<p>\u00a0</p>"));
  });

  it("should not escape script/style contents", () => {
    expect(roundPrint(FULL('<script>if (a<b) x="&";</script>'))).toBe(
      FULL('<script>if (a<b) x="&";</script>'),
    );
    expect(roundPrint(FULL('<style>a>b{content:"&"}</style>'))).toBe(
      FULL('<style>a>b{content:"&"}</style>'),
    );
  });
});

describe("serializeHtml · 手搓树的 raw text 继承", () => {
  it("should inherit raw-text mode into nested elements built by hand", () => {
    const tree = fromRoot({
      kind: "element",
      tag: "script",
      attrs: [],
      children: [
        {
          kind: "element",
          tag: "div",
          attrs: [],
          children: [{ kind: "text", value: "<b>&" }],
        },
      ],
    });

    expect(serializeHtml(tree)).toBe("<script><div><b>&</div></script>");
  });
});

describe("serializeHtml · 标签形状", () => {
  it("should not emit closing tags or self-closing slashes for void elements", () => {
    expect(roundPrint(FULL('<p>a<br>b<img src="x"></p>'))).toBe(FULL('<p>a<br>b<img src="x"></p>'));
    expect(roundPrint(FULL("<div>a<hr></div>"))).toBe(FULL("<div>a<hr></div>"));
  });

  it("should emit tags without attributes when attrs is empty", () => {
    expect(roundPrint(FULL("<div>x</div>"))).toBe(FULL("<div>x</div>"));
  });

  it("should drop exactly the spec-mandated leading newline inside pre, then preserve whitespace", () => {
    const source = FULL("<pre>\n\n  a\n    b\t\n</pre>");
    const expected = FULL("<pre>\n  a\n    b\t\n</pre>");

    expect(roundPrint(source)).toBe(expected);
  });

  it("should preserve comments byte for byte", () => {
    expect(roundPrint(FULL("<!--a<b&c-->x"))).toBe(FULL("<!--a<b&c-->x"));
  });

  it("should serialize an empty document to the empty string", () => {
    expect(serializeHtml(parseHtml(""))).toBe("");
  });
});

describe("serializeHtml · doctype", () => {
  it("should emit a bare doctype when no identifiers exist", () => {
    expect(roundPrint("<!DOCTYPE html>")).toBe(`<!DOCTYPE html>${EMPTY_BODY}`);
  });

  it("should emit PUBLIC + system identifier", () => {
    const doctype =
      '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">';

    expect(roundPrint(doctype)).toBe(`${doctype}${EMPTY_BODY}`);
  });

  it("should emit a system-only doctype without a PUBLIC keyword", () => {
    const doctype = '<!DOCTYPE html SYSTEM "about:legacy-compat">';

    expect(roundPrint(doctype)).toBe(`${doctype}${EMPTY_BODY}`);
  });

  it("should emit PUBLIC with an empty system identifier (hand-built tree)", () => {
    const tree = fromRoot({
      kind: "document",
      children: [{ kind: "doctype", name: "html", publicId: "p", systemId: "" }],
    });

    expect(serializeHtml(tree)).toBe('<!DOCTYPE html PUBLIC "p" "">');
  });
});

describe("serializeHtml · 全节点种类覆盖", () => {
  it("should serialize a hand-built document containing every node kind", () => {
    const tree = fromRoot({
      kind: "document",
      children: [
        { kind: "doctype", name: "html", publicId: "", systemId: "" },
        { kind: "comment", data: "top" },
        { kind: "text", value: "a<b" },
        {
          kind: "element",
          tag: "p",
          attrs: [["class", "x"]],
          children: [{ kind: "text", value: "t" }],
        },
      ],
    });

    expect(serializeHtml(tree)).toBe('<!DOCTYPE html><!--top-->a&lt;b<p class="x">t</p>');
  });
});
