// Self-tests for the shared checkers, mutation-style: a planted violation must be caught
// and a clean input must pass — otherwise a checker could silently stop judging anything.
// The DOM cases run against a tiny structural fake so the corpus stays dependency-free;
// happy-dom and real DOM nodes satisfy the same DomNodeLike shape in feature suites.

import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it } from "vitest";

import {
  assertNoElementsFromData,
  CheckerInternalError,
  type DomContainerLike,
  type DomNodeLike,
} from "./no-elements-from-data.ts";
import { assertNoHostPaths } from "./no-host-paths.ts";
import {
  byAttribute,
  byTag,
  diffStructure,
  type DiffStructureOptions,
  type DiffStructureStats,
  type StructureDiff,
} from "./structure-diff.ts";
import { nestedTagHtml } from "./html-malformed.ts";
import { XSS_PAYLOADS } from "./xss.ts";

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

  // Every shape the checker already caught must stay caught — the boundary rule
  // below is only allowed to reject false positives, never true ones.
  it.each([
    "/Users/x",
    "file:///Users/x",
    "\\/Users\\/x",
    'wrote to "/tmp/a" at the end',
    "log tail: /private/var",
    "wrote /tmp/a",
    "see /var/folders/abc",
    "/home/u",
    "receipt ends at /var",
    "saved to C:\\Users\\x",
    "saved to c:/users/x",
    "saved to D:/work/f",
  ])("should still flag the previously-caught shape %s", (output) => {
    expect(() => {
      assertNoHostPaths(output);
    }).toThrow(/host path leaked/u);
  });

  it.each([
    "out/tmp/x.html",
    "docs/home/p.html",
    "src/private/k.pem",
    "assets/var/x.css",
    "lists/Users/all",
  ])("should not flag a host root embedded inside a relative path: %s", (output) => {
    expect(() => {
      assertNoHostPaths(output);
    }).not.toThrow();
  });

  // Host roots are case-insensitive like the macOS filesystem they name.
  it.each(["/users/x", "/TMP/x", "/Private/var/y", "/HOME/u", "/Var/folders/x"])(
    "should flag a host root regardless of case: %s",
    (output) => {
      expect(() => {
        assertNoHostPaths(output);
      }).toThrow(/host path leaked/u);
    },
  );

  // Every real spelling of a file: URL that ends in a host path counts.
  it.each([
    "FILE:///Users/x",
    "File:///tmp/a",
    "file://localhost/Users/x",
    "file://host/Users/x",
    "file:////Users/x",
    "file://./Users/x",
    "file:/Users/x",
    "url=file:\\\\/\\\\/localhost\\\\/Users\\\\/x",
    "file:%2F%2Flocalhost%2FUsers%2Fx",
    "%66ile:///%55sers/x",
  ])("should flag a host root behind a file: URL prefix: %s", (output) => {
    expect(() => {
      assertNoHostPaths(output);
    }).toThrow(/host path leaked/u);
  });

  it("should not treat a non-file scheme prefix as a file URL", () => {
    expect(() => {
      assertNoHostPaths("profile:///Users/x is not a file URL");
    }).not.toThrow();
    expect(() => {
      assertNoHostPaths("myfile:///Users/x is not a file URL");
    }).not.toThrow();
  });

  // NUL and `*` are delimiters — they were caught before and must stay caught.
  it.each(["x\u0000/Users/x", "*/Users/x", "glob *\u0000/tmp/a"])(
    "should flag a host root after a NUL or star delimiter: %s",
    (output) => {
      expect(() => {
        assertNoHostPaths(output);
      }).toThrow(/host path leaked/u);
    },
  );

  it.each(["wrote %2FUsers%2Fx", "file:%2F%2F%2FUsers", "path=%2fvar%2ffolders%2fx"])(
    "should decode percent-encoded host paths: %s",
    (output) => {
      expect(() => {
        assertNoHostPaths(output);
      }).toThrow(/host path leaked/u);
    },
  );

  it("should survive malformed percent escapes and still flag real roots", () => {
    expect(() => {
      assertNoHostPaths("100% covered, no %zz escapes");
    }).not.toThrow();
    expect(() => {
      assertNoHostPaths("50% done, wrote /tmp/a");
    }).toThrow(/host path leaked/u);
  });

  it.each([
    "\\\\server\\share",
    "to //server/share please",
    "x = \\\\server\\share",
    '{"p": "\\\\\\\\server\\\\share"}',
    '{"p": "\\/\\/server\\/share"}',
  ])("should flag a UNC share prefix: %s", (output) => {
    expect(() => {
      assertNoHostPaths(output);
    }).toThrow(/host path leaked/u);
  });

  it("should not treat a URL scheme's // as a UNC share", () => {
    expect(() => {
      assertNoHostPaths("https://server/share");
    }).not.toThrow();
    expect(() => {
      assertNoHostPaths("see https://host.example/tmp/a in docs");
    }).not.toThrow();
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

  it("should flag a comment change outside the edited subtree", () => {
    const before = "<body><p>a</p><!-- c1 --></body>";
    const after = "<body><p>a</p><!-- c2 --></body>";
    const diffs = diffStructure(before, after);
    expect(kinds(diffs)).toEqual(["own-text"]);
    expect(diffs[0]?.path).toBe("html/body/#comment");
    expect(diffs[0]?.before).toBe(" c1 ");
    expect(diffs[0]?.after).toBe(" c2 ");
  });

  it("should flag an inserted and a removed comment", () => {
    const bare = "<body><p>a</p></body>";
    const commented = "<body><p>a</p><!-- note --></body>";
    expect(kinds(diffStructure(bare, commented))).toContain("extra-after");
    expect(kinds(diffStructure(commented, bare))).toContain("missing-after");
  });

  it("should flag a dropped doctype and a swapped public id", () => {
    const withDoctype = "<!DOCTYPE html><html><body><p>a</p></body></html>";
    const withoutDoctype = "<html><body><p>a</p></body></html>";
    expect(kinds(diffStructure(withDoctype, withoutDoctype))).toContain("missing-after");

    const publicA =
      '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>a</p>';
    const publicB =
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><p>a</p>';
    expect(kinds(diffStructure(publicA, publicB))).toContain("attributes");
  });

  it("should flag an inserted bogus comment", () => {
    const bare = "<body><p>a</p></body>";
    const bogus = "<body><p>a</p><?x></body>";
    expect(kinds(diffStructure(bare, bogus))).toContain("extra-after");
  });

  it("should throw when the locator matches more than one element", () => {
    const before = "<section>x</section><section>y</section>";
    const after = "<section>x</section><section>TAMPERED</section>";
    expect(() => {
      diffStructure(before, after, byTag("section"));
    }).toThrow(/matched 2 elements/u);
  });

  it("should keep allowing zero locator matches (insert or delete)", () => {
    const before = "<body><article>x</article></body>";
    const after = '<body><article>x</article><section id="new">y</section></body>';
    // Zero matches in `before`, one in `after`: the inserted subtree is the edit
    // itself, so the aligned lists stay identical and diffs are empty. Asserting
    // WHERE the element landed is the caller's job (documented in the JSDoc).
    expect(diffStructure(before, after, byAttribute("id", "new"))).toEqual([]);
  });

  it("should report a move of the edited element to a new sibling index", () => {
    const before =
      "<body><article>" +
      '<p data-hr-id="c">one</p><p data-hr-id="d">two</p>' +
      "</article></body>";
    const after =
      "<body><article>" +
      '<p data-hr-id="d">two</p><p data-hr-id="c">one</p>' +
      "</article></body>";
    const diffs = diffStructure(before, after, byAttribute("data-hr-id", "c"));
    expect(kinds(diffs)).toEqual(["moved"]);
    expect(diffs[0]?.before).toBe("html/body/article[0]");
    expect(diffs[0]?.after).toBe("html/body/article[1]");
  });

  it("should report a move of the edited element to a different parent", () => {
    const before = '<body><article><p data-hr-id="c">x</p></article><footer></footer></body>';
    const after = '<body><article></article><footer><p data-hr-id="c">x</p></footer></body>';
    const diffs = diffStructure(before, after, byAttribute("data-hr-id", "c"));
    expect(kinds(diffs)).toEqual(["moved"]);
  });

  it("should suppress the move report when allowMove is set", () => {
    const before =
      "<body><article>" +
      '<p data-hr-id="c">one</p><p data-hr-id="d">two</p>' +
      "</article></body>";
    const after =
      "<body><article>" +
      '<p data-hr-id="d">two</p><p data-hr-id="c">one</p>' +
      "</article></body>";
    const options: DiffStructureOptions = { allowMove: true };
    expect(diffStructure(before, after, byAttribute("data-hr-id", "c"), options)).toEqual([]);
  });

  it("should flag a text/comment reorder inside one element", () => {
    const before = "<body><p>x<!--c--></p></body>";
    const after = "<body><p><!--c-->x</p></body>";
    expect(kinds(diffStructure(before, after))).toEqual(["child-order"]);
  });

  it("should flag a comment/element reorder inside one element", () => {
    const before = "<body><p><!--c--><b>i</b></p></body>";
    const after = "<body><p><b>i</b><!--c--></p></body>";
    expect(kinds(diffStructure(before, after))).toContain("child-order");
  });

  it("should flag two text runs swapped around a comment", () => {
    const before = "<body><p>x<!--c-->y</p></body>";
    const after = "<body><p>y<!--c-->x</p></body>";
    expect(kinds(diffStructure(before, after))).toContain("own-text");
  });

  it("should not flag a tag swap as a child-order change (order is kind-level)", () => {
    const before = "<body><p><b>1</b><i>2</i></p></body>";
    const after = "<body><p><i>2</i><b>1</b></p></body>";
    // Kind order is E,E in both — the swap still shows as aligned tag diffs.
    expect(kinds(diffStructure(before, after))).not.toContain("child-order");
    expect(kinds(diffStructure(before, after))).toContain("tag");
  });

  it("should not count the edited element in its parent's child order", () => {
    const before = "<body><article><p>x</p></article><footer></footer></body>";
    const after = "<body><article></article><footer><p>x</p></footer></body>";
    // The <p> moved — but if it is the located edit, the parent's order signal
    // must skip it, so the only report is `moved`.
    const diffs = diffStructure(before, after, byTag("p"));
    expect(kinds(diffs)).toEqual(["moved"]);
  });

  it("should not crash on a wide flat document (children are never spread into a call)", () => {
    const html = `<body>${"<b>x</b>".repeat(200_000)}</body>`;
    const stats: DiffStructureStats = { nodesVisited: 0, chainsCreated: 0, chainStringsBuilt: 0 };
    expect(diffStructure(html, html, undefined, { stats })).toEqual([]);
    expect(stats.nodesVisited).toBeGreaterThan(200_000);
    // 200k sibling <b> elements share ONE interned ancestor chain.
    expect(stats.chainsCreated).toBeLessThan(20);
    // Identical documents report no diffs, so no ancestor string is ever built.
    expect(stats.chainStringsBuilt).toBe(0);
  });

  it("should not copy ancestor chains per node on a deep document", () => {
    const deep = nestedTagHtml("div", 20_000);
    const stats: DiffStructureStats = { nodesVisited: 0, chainsCreated: 0, chainStringsBuilt: 0 };
    expect(diffStructure(deep, deep, undefined, { stats })).toEqual([]);
    expect(stats.nodesVisited).toBeGreaterThanOrEqual(20_000);
    // Each level interns at most one chain object — never an O(depth) copy per node.
    expect(stats.chainsCreated).toBeLessThanOrEqual(stats.nodesVisited);
    expect(stats.chainStringsBuilt).toBe(0);
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
  attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
  childNodes: children,
});

const root = (children: DomNodeLike[]): DomContainerLike => ({ childNodes: children });

// parse5's default tree adapter carries no numeric nodeType — map it onto DomNodeLike.
// Iterative on purpose: a recursive walk overflows the call stack on the 20k-deep
// corpus entries.
const p5Children = (
  node: DefaultTreeAdapterTypes.Node,
): readonly DefaultTreeAdapterTypes.Node[] => {
  if ("content" in node) return node.content.childNodes;
  if ("childNodes" in node) return node.childNodes;
  return [];
};

const domOf = (rootNode: DefaultTreeAdapterTypes.Node): DomNodeLike => {
  type MutableDom = DomNodeLike & { childNodes: DomNodeLike[] };
  const wrapped = new Map<DefaultTreeAdapterTypes.Node, MutableDom>();
  const order: DefaultTreeAdapterTypes.Node[] = [];
  const stack: DefaultTreeAdapterTypes.Node[] = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    order.push(node);
    const kids = p5Children(node);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const kid = kids[i];
      if (kid !== undefined) stack.push(kid);
    }
  }
  for (const node of order) {
    const wrap: MutableDom =
      "tagName" in node
        ? { nodeType: 1, tagName: node.tagName, attrs: node.attrs, childNodes: [] }
        : "value" in node
          ? { nodeType: 3, nodeValue: node.value, childNodes: [] }
          : { nodeType: 8, childNodes: [] };
    wrapped.set(node, wrap);
  }
  for (const node of order) {
    const parent = wrapped.get(node);
    for (const child of p5Children(node)) {
      const wrappedChild = wrapped.get(child);
      if (parent !== undefined && wrappedChild !== undefined) parent.childNodes.push(wrappedChild);
    }
  }
  const result = wrapped.get(rootNode);
  if (result === undefined) throw new Error("unreachable: the root was never wrapped");
  return result;
};

/** Parses `html` as a fragment and wraps it in the structural shape the checker walks. */
const fragmentOf = (html: string): DomContainerLike => ({
  childNodes: parseFragment(html).childNodes.map(domOf),
});

/** Every text node under the container, in document order — iterative like the checker. */
const textsIn = (container: DomContainerLike): string[] => {
  const out: string[] = [];
  const stack = [...container.childNodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.nodeType === 3) out.push(node.nodeValue ?? "");
    if (node.childNodes !== undefined) {
      const kids = [...node.childNodes];
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        const kid = kids[i];
        if (kid !== undefined) stack.push(kid);
      }
    }
  }
  return out;
};

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
    "math",
    "annotation-xml",
    "video",
    "audio",
    "source",
    "details",
    "marquee",
    "noscript",
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
    "data:text/html,<b>x</b>",
    "javascript&#58;x",
    "&#106;avascript:x",
    "javascript&#x3a;x",
    "java&Tab;script:x",
    "data&colon;text/html,x",
  ])("should fail when <a> carries the dangerous-scheme href %s", (href) => {
    const container = root([el("a", [text("click")], { href })]);
    expect(() => {
      assertNoElementsFromData(container, ["click"]);
    }).toThrow(/dangerous-scheme href/u);
  });

  it.each([
    ["formaction", "javascript:alert(1)"],
    ["src", "data:text/html,<b>x</b>"],
    ["src", "vbscript:x"],
    ["action", "javascript:x"],
    ["xlink:href", "javascript:alert(1)"],
  ])("should fail on the %s attribute carrying %s", (name, value) => {
    const container = root([el("button", [text("go")], { [name]: value })]);
    expect(() => {
      assertNoElementsFromData(container, ["go"]);
    }).toThrow(new RegExp(`dangerous-scheme ${name}`, "u"));
  });

  it("should fail on a srcdoc attribute", () => {
    const container = root([el("div", [text("x")], { srcdoc: "<script>alert(1)</script>" })]);
    expect(() => {
      assertNoElementsFromData(container, ["x"]);
    }).toThrow(/srcdoc/u);
  });

  it.each(["onmouseover", "onclick", "ontoggle", "OnError", "ONLOAD"])(
    "should fail on a benign element carrying the handler attribute %s",
    (name) => {
      const container = root([el("b", [text("safe")], { [name]: "x" })]);
      expect(() => {
        assertNoElementsFromData(container, ["safe"]);
      }).toThrow(/handler attribute/u);
    },
  );

  it("should fail on the reviewer's handler-attribute probes through real parses", () => {
    expect(() => {
      assertNoElementsFromData(fragmentOf("<b onmouseover=x>t</b>"), ["t"]);
    }).toThrow(/handler attribute/u);
    expect(() => {
      assertNoElementsFromData(fragmentOf("<p onclick=x>t</p>"), ["t"]);
    }).toThrow(/handler attribute/u);
    expect(() => {
      assertNoElementsFromData(fragmentOf("<details open ontoggle=alert(1)>x</details>"), []);
    }).toThrow(/data rendered as/u);
    expect(() => {
      assertNoElementsFromData(fragmentOf("<video><source onerror=alert(1)></video>"), []);
    }).toThrow(/data rendered as/u);
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

  it("should not crash on an element with hundreds of thousands of children", () => {
    const children = Array.from({ length: 500_000 }, () => el("b", [text("x")]));
    const container = root([el("div", children)]);
    expect(() => {
      assertNoElementsFromData(
        container,
        children.map(() => "x"),
      );
    }).not.toThrow();
  });

  it("should flag a doubled attr prefix (name='xlink:href', prefix='xlink')", () => {
    const node: DomNodeLike = {
      nodeType: 1,
      tagName: "A",
      attributes: [{ name: "xlink:href", value: "javascript:alert(1)", prefix: "xlink" }],
      childNodes: [text("x")],
    };
    expect(() => {
      assertNoElementsFromData(root([node]), ["x"]);
    }).toThrow(/dangerous-scheme/u);
  });

  it("should throw CheckerInternalError when an element hides its attribute list", () => {
    // A container exposing only getAttribute cannot be checked for on* handlers —
    // silence would pass payloads like <b onmouseover=x>.
    const node: DomNodeLike = {
      nodeType: 1,
      tagName: "B",
      getAttribute: () => null,
      childNodes: [text("x")],
    };
    expect(() => {
      assertNoElementsFromData(root([node]), ["x"]);
    }).toThrow(CheckerInternalError);
  });

  it("should rethrow internal crashes as CheckerInternalError, never as a violation", () => {
    // A structurally broken container (childNodes that is not iterable) must surface
    // as an internal error — a generic throw could be mistaken for a caught violation.
    const broken: DomNodeLike = {
      nodeType: 1,
      tagName: "DIV",
      attributes: [],
      childNodes: 42 as unknown as DomNodeLike[],
    };
    let caught: unknown;
    try {
      assertNoElementsFromData(root([broken]), []);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CheckerInternalError);
    expect((caught as Error).message).not.toMatch(/data rendered as/u);
  });
});

// The corpus itself is the regression matrix: every payload that parses to markup
// must be rejected, and every entry marked inert must genuinely parse inert.
describe("XSS_PAYLOADS under assertNoElementsFromData", () => {
  it.each(XSS_PAYLOADS.map((entry) => [entry.id, entry] as const))(
    "should judge %s exactly as marked",
    (_id, entry) => {
      const container = fragmentOf(entry.payload);
      if (entry.inertReason === undefined) {
        expect(() => {
          assertNoElementsFromData(container, []);
        }).toThrow(/data rendered as/u);
      } else {
        // An inert marking must be honest: the checker accepts when the texts match.
        expect(() => {
          assertNoElementsFromData(container, textsIn(container));
        }).not.toThrow();
      }
    },
  );
});
