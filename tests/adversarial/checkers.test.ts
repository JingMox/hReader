// Self-tests for the shared checkers, mutation-style: a planted violation must be caught
// and a clean input must pass — otherwise a checker could silently stop judging anything.
// The DOM cases run against a tiny structural fake so the corpus stays dependency-free;
// happy-dom and real DOM nodes satisfy the same DomNodeLike shape in feature suites.

import { describe, expect, it } from "vitest";

import {
  assertNoElementsFromData,
  type DomContainerLike,
  type DomNodeLike,
} from "./no-elements-from-data.ts";
import { assertNoHostPaths } from "./no-host-paths.ts";
import { byAttribute, byTag, diffStructure, type StructureDiff } from "./structure-diff.ts";

const kinds = (diffs: readonly StructureDiff[]): StructureDiff["kind"][] =>
  diffs.map((diff) => diff.kind);

describe("assertNoHostPaths", () => {
  it("should pass clean output", () => {
    expect(() => {
      assertNoHostPaths("patched doc.html (+3 bytes, +0 ids)");
    }).not.toThrow();
    expect(() => {
      assertNoHostPaths("");
    }).not.toThrow();
  });

  it.each(["/Users/x/doc.html", "/private/tmp/x", "/tmp/x", "/var/folders/x", "/home/u/x"])(
    "should fail when output contains %s",
    (root) => {
      expect(() => {
        assertNoHostPaths(`wrote 12 bytes to ${root}`);
      }).toThrow(/host path leaked/u);
    },
  );

  it("should fail on a Windows drive path", () => {
    expect(() => {
      assertNoHostPaths("saved to C:\\Users\\x\\doc.html");
    }).toThrow(/host path leaked/u);
  });

  it("should fail on an extra root and pass when the extra root is absent", () => {
    expect(() => {
      assertNoHostPaths("receipt for sub/b.html", ["/repo/ws"]);
    }).not.toThrow();
    expect(() => {
      assertNoHostPaths("receipt for /repo/ws/sub/b.html", ["/repo/ws"]);
    }).toThrow(/host path leaked/u);
  });

  it("should ignore empty extra roots instead of flagging everything", () => {
    expect(() => {
      assertNoHostPaths("any output", [""]);
    }).not.toThrow();
  });
});

describe("diffStructure", () => {
  const BEFORE =
    "<!doctype html><html><body><article>" +
    '<h2 data-hr-id="hr-b">t</h2><p data-hr-id="hr-c">one</p><p data-hr-id="hr-d">two</p>' +
    "</article></body></html>";

  it("should report no differences between identical documents", () => {
    expect(diffStructure(BEFORE, BEFORE)).toEqual([]);
  });

  it("should flag a text change in an element outside the edited subtree", () => {
    const after = BEFORE.replace(">two</p>", ">TWO</p>");
    const diffs = diffStructure(BEFORE, after);
    expect(kinds(diffs)).toEqual(["own-text"]);
    expect(diffs[0]?.path).toBe("html/body/article/p");
    expect(diffs[0]?.before).toBe("two");
    expect(diffs[0]?.after).toBe("TWO");
  });

  it("should flag an attribute change outside the edited subtree", () => {
    const after = BEFORE.replace('data-hr-id="hr-d"', 'data-hr-id="hr-d" class="c"');
    const diffs = diffStructure(BEFORE, after);
    expect(kinds(diffs)).toEqual(["attributes"]);
  });

  it("should flag a tag change outside the edited subtree", () => {
    const after = BEFORE.replace("<h2", "<h3").replace("</h2>", "</h3>");
    expect(kinds(diffStructure(BEFORE, after))).toEqual(["tag"]);
  });

  it("should flag a removed and an added element", () => {
    const removed = BEFORE.replace('<p data-hr-id="hr-d">two</p>', "");
    expect(kinds(diffStructure(BEFORE, removed))).toContain("missing-after");
    const added = BEFORE.replace("</article>", "<footer>f</footer></article>");
    expect(kinds(diffStructure(BEFORE, added))).toContain("extra-after");
  });

  it("should flag an ancestor-chain change while other elements stay aligned", () => {
    const after = BEFORE.replace("<h2", "<header><h2").replace("</h2>", "</h2></header>");
    const diffs = diffStructure(BEFORE, after);
    expect(kinds(diffs)).toContain("ancestors");
    expect(kinds(diffs)).toContain("extra-after");
  });

  it("should ignore changes confined to the edited subtree", () => {
    const after = BEFORE.replace(
      '<p data-hr-id="hr-c">one</p>',
      '<section data-hr-id="hr-c"><p>n1</p><p>n2</p></section>',
    );
    const edited = byAttribute("data-hr-id", "hr-c");
    expect(diffStructure(BEFORE, after, edited)).toEqual([]);
  });

  it("should still flag an outside change when the edited subtree also changed", () => {
    const after = BEFORE.replace(
      '<p data-hr-id="hr-c">one</p>',
      '<section data-hr-id="hr-c">new</section>',
    ).replace(">two</p>", ">TWO</p>");
    const diffs = diffStructure(BEFORE, after, byAttribute("data-hr-id", "hr-c"));
    expect(kinds(diffs)).toEqual(["own-text"]);
  });

  it("should locate the edited element by tag as well", () => {
    const before = "<body><article>x</article><p>s</p></body>";
    const after = "<body><article>y</article><p>s</p></body>";
    expect(diffStructure(before, after, byTag("article"))).toEqual([]);
  });

  it("should compare elements inside <noscript> (scripting-off parse)", () => {
    const before = "<body><noscript><p>x</p></noscript></body>";
    const after = "<body><noscript><div>x</div></noscript></body>";
    expect(kinds(diffStructure(before, after))).toEqual(["tag"]);
  });

  it("should see through <template> content boundaries", () => {
    const before = "<body><template><p>x</p></template></body>";
    const after = "<body><template><p>y</p></template></body>";
    expect(kinds(diffStructure(before, after))).toEqual(["own-text"]);
  });
});

// A minimal structural fake — the same shape happy-dom and real DOM nodes satisfy.
const text = (value: string): DomNodeLike => ({
  nodeType: 3,
  nodeValue: value,
  childNodes: [],
});

const el = (
  tag: string,
  children: DomNodeLike[],
  attrs: Record<string, string> = {},
): DomNodeLike => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  getAttribute: (name: string) => attrs[name] ?? null,
  childNodes: children,
});

const root = (children: DomNodeLike[]): DomContainerLike => ({ childNodes: children });

describe("assertNoElementsFromData", () => {
  it("should pass when the container holds only safe elements and the expected texts", () => {
    const container = root([el("p", [text("hello "), el("b", [text("world")])])]);
    expect(() => {
      assertNoElementsFromData(container, ["hello ", "world"]);
    }).not.toThrow();
  });

  it.each([
    "img",
    "script",
    "svg",
    "iframe",
    "object",
    "embed",
    "form",
    "style",
    "link",
    "meta",
    "base",
  ])("should fail when a <%s> element appears in the rendered data", (tag) => {
    const container = root([el("p", [text("safe")]), el(tag, [text("payload")])]);
    expect(() => {
      assertNoElementsFromData(container, ["safe", "payload"]);
    }).toThrow(new RegExp(`dangerous <${tag}>`, "u"));
  });

  it("should fail on a deeply nested dangerous element, not just a top-level one", () => {
    const container = root([el("div", [el("div", [el("div", [el("img", [])])])])]);
    expect(() => {
      assertNoElementsFromData(container, []);
    }).toThrow(/dangerous <img>/u);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:x",
    "vbscript:x",
  ])("should fail when <a> carries the script-scheme href %s", (href) => {
    const container = root([el("a", [text("click")], { href })]);
    expect(() => {
      assertNoElementsFromData(container, ["click"]);
    }).toThrow(/script-scheme href/u);
  });

  it("should pass an <a> with a benign href", () => {
    const container = root([el("a", [text("link")], { href: "https://example.com/" })]);
    expect(() => {
      assertNoElementsFromData(container, ["link"]);
    }).not.toThrow();
  });

  it("should fail when the rendered text differs from the expected data", () => {
    const container = root([el("p", [text("tampered")])]);
    expect(() => {
      assertNoElementsFromData(container, ["expected"]);
    }).toThrow(/mismatch/u);
  });

  it("should fail when a text node is missing or extra", () => {
    const container = root([el("p", [text("a"), text("b")])]);
    expect(() => {
      assertNoElementsFromData(container, ["a"]);
    }).toThrow(/count/u);
    expect(() => {
      assertNoElementsFromData(container, ["a", "b", "c"]);
    }).toThrow(/count/u);
  });

  it("should count whitespace-only text nodes like any other", () => {
    const container = root([text(" "), el("p", [text("x")])]);
    expect(() => {
      assertNoElementsFromData(container, [" ", "x"]);
    }).not.toThrow();
    expect(() => {
      assertNoElementsFromData(container, ["x"]);
    }).toThrow(/count/u);
  });
});
