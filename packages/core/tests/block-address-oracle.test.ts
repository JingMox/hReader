// This layer covers the D60 patch-time oracle: listing is heuristic — a listed block's
// range can still hide unowned bytes — so before ANY write the oracle re-parses the
// byte-splice and compares it against the original tree minus the block's subtree.
// Only when the two sides agree byte-for-byte may the write happen; anything else is
// `target_moved`. Refused or exact, never corrupt.

import { describe, expect, it } from "vitest";

import { parseHtml, serializeHtml, type HtmlNode } from "../src/html";
import {
  applyBlockPatch,
  listBlocks,
  type BlockPatchOutcome,
  type BlockPatchRequest,
} from "../src/ops/block-address";

/**
 * The oracle's `expected` side, rebuilt independently: parse the document, cut the
 * element whose span is exactly `[start, end)` out of its parent's children, and
 * serialize the remainder. If re-parsing the splice produces this same serialization,
 * removing the range was construction-exact.
 */
const cutBlock = (root: HtmlNode, start: number, end: number): HtmlNode => {
  if (root.kind !== "element" && root.kind !== "document") return root;
  return {
    ...root,
    children: root.children
      .filter(
        (child) =>
          !(child.kind === "element" && child.span?.start === start && child.span.end === end),
      )
      .map((child) => cutBlock(child, start, end)),
  };
};

const minusBlockSerialized = (html: string, start: number, end: number): string =>
  serializeHtml({
    root: cutBlock(parseHtml(html, { locations: true }).root, start, end),
    diagnostics: [],
  });

/** applyBlockPatch that reports an oracle refusal instead of throwing. */
const patchOrRefused = (
  html: string,
  request: BlockPatchRequest,
): { outcome: BlockPatchOutcome | undefined; refused: boolean } => {
  try {
    return { outcome: applyBlockPatch(html, request), refused: false };
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "target_moved") return { outcome: undefined, refused: true };
    throw error;
  }
};

describe("patch-time oracle (D60)", () => {
  // Listing stays heuristic; the oracle is the guarantee. For every listed block in
  // every repro document from rounds 1–3, a delete either refuses with target_moved or
  // lands byte-exactly: the splice removes the block's own bytes and nothing else.
  const REPROS: readonly string[] = [
    // Round 1–2: ignored end tags carrying no location.
    "<p>x</body>tail",
    "<p>x</html>tail",
    "<p>x<div>y</body>tail",
    "<body><svg><p>x</svg></body>",
    "<body><svg><foreignObject><p>x</foreignObject></svg></body>",
    "<body><noscript><p>x</noscript>tail",
    "<head><p>x</head><body><p>y</body>",
    "<b><p>x<i>y</b>z</p>tail",
    "<body><h5></tr></body>",
    "<template><article>",
    "<body><template><p>x",
    "<body><ul><li>a<li>b</ul>TRAIL<li>c</body>",
    "<body><li>a<li>b</body>",
    "<body><p>x</body>",
    // Round 2–3: fostered content, folded tags, bogus comments.
    '<html><body><footer><thead>x</thead><table><pre attr="v"></pre></body></html>',
    "<body><table>abc<tr><td>x</td></tr></table>",
    "<body><table><!-- c --><tr><td>x</td></tr></table>",
    "<body><table><?pi?><tr><td>x</td></tr></table>",
    "<body><table><p>x</table></body>",
    "<p>x<body>y",
    "<p>x<td>y</p>",
    "<p>a</2>b",
    "<p></>",
    "<p>a</>b",
    "<p>x<",
    "<p>a<{b</p>",
    "<p>a < b</p>",
    "<div>x<!-- c </p> -->y</div>",
    "<div><script>a</b>x</script></div>",
    "<div><textarea>a</b>x</textarea></div>",
    // Round 4: straddling foreign leaves and ignored `<!…` markup.
    "<dl><dd>c <table>x<td>cell",
    "<div>c <table>x<td>cell",
    "<ul><li>c <table>x<td>cell",
    "<dl><dd>c <table>x<td>cell</table></dd></dl>",
    "<p>x<!DOCTYPE y>z</p>",
    "<div><select><a>x</select></div>",
    "<div><select><z>x</select></div>",
    "<div><select><A>x</select></div>",
    "<div><select><Z>x</select></div>",
    "<div><p>",
  ];

  it("should never corrupt a listed block on delete — refuse or reparse-exact", () => {
    for (const html of REPROS) {
      for (const block of listBlocks(html)) {
        const stripped = `${html.slice(0, block.start)}${html.slice(block.end)}`;
        const { outcome, refused } = patchOrRefused(html, {
          address: block.address,
          action: "delete",
        });
        if (refused) {
          expect(outcome).toBeUndefined();
          continue;
        }
        expect(outcome).toBeDefined();
        // Accepted: only the block's own bytes went, and the splice re-parses to
        // exactly the original tree minus the block's subtree.
        expect(outcome?.html).toBe(stripped);
        expect(serializeHtml(parseHtml(outcome?.html ?? ""))).toBe(
          minusBlockSerialized(html, block.start, block.end),
        );
      }
    }
  });

  it("should accept every action on a single-block document — an empty splice is an empty body", () => {
    // Removing the only block leaves "" — the scaffold the tree-minus-side carries is
    // implicit, so an empty re-parse and an empty scaffold must compare equal (D64).
    for (const html of ["<div>hello</div>", "<p></p>"]) {
      const [block] = listBlocks(html);
      expect(block).toBeDefined();
      const deleted = applyBlockPatch(html, { address: block?.address ?? "", action: "delete" });
      expect(deleted.html).toBe("");
      for (const [action, fragment, expected] of [
        ["replace", "<p>r</p>", "<p>r</p>"],
        ["insertBefore", "<p>b</p>", `<p>b</p>${html}`],
        ["insertAfter", "<p>a</p>", `${html}<p>a</p>`],
      ] as const) {
        const outcome = applyBlockPatch(html, {
          address: block?.address ?? "",
          action,
          html: fragment,
        });
        expect(outcome.html).toBe(expected);
      }
    }
  });

  it("should refuse writes whose result does not re-parse into the block's context", () => {
    // The D64 post-write oracle: the splice check only covers the bytes a write
    // REMOVES. The writing actions must also land: the fragment's top-level nodes
    // parse as children of the block's original parent at the block's position, and
    // every element outside the block keeps its tag, attributes, own direct text and
    // ancestor chain. Each case below writes bytes that re-parse to a different tree.
    const cases: readonly (readonly [
      string,
      string,
      readonly ("replace" | "insertBefore" | "insertAfter")[],
    ])[] = [
      // Scope-close: an li/dd/dt/button start tag inside the open li/dt/dd/button
      // scope closes the context and reparents the fragment — and the original
      // block's bytes end up owned by a different parent.
      [
        "<ul><li><div><p>x</p></div></li></ul>",
        "<li>f</li>",
        ["insertBefore", "insertAfter", "replace"],
      ],
      [
        "<dl><dt><div><p>x</p></div></dt></dl>",
        "<dd>f</dd>",
        ["insertBefore", "insertAfter", "replace"],
      ],
      [
        "<dl><dd><div><p>x</p></div></dd></dl>",
        "<dt>f</dt>",
        ["insertBefore", "insertAfter", "replace"],
      ],
      [
        "<button><div><p>x</p></div></button>",
        "<button>f</button>",
        ["insertBefore", "insertAfter", "replace"],
      ],
      // Adoption agency: a formatting element inside its own scope is removed and
      // reparented — replace goes through the same split as the inserts.
      ["<a><div><p>x</p></div></a>", "<a>f</a>", ["insertBefore", "insertAfter", "replace"]],
      [
        "<nobr><div><p>x</p></div></nobr>",
        "<nobr>f</nobr>",
        ["insertBefore", "insertAfter", "replace"],
      ],
      // A `<form>` inside a form is dropped by the parser; its children leak.
      [
        "<form><div><p>x</p></div></form>",
        "<form><p>f</p></form>",
        ["insertBefore", "insertAfter", "replace"],
      ],
      // Foreign content: HTML block tags inside svg/math break out to body.
      ["<svg><p>x</p></svg>", "<p>f</p>", ["insertBefore", "insertAfter", "replace"]],
      [
        "<svg><div><p>x</p></div></svg>",
        "<blockquote><p>f</p></blockquote>",
        ["insertBefore", "insertAfter", "replace"],
      ],
      [
        "<math><p>x</p></math>",
        "<table><tr><td>f</td></tr></table>",
        ["insertBefore", "insertAfter", "replace"],
      ],
      // Unclosed raw text swallows a fragment written at the range's end offset —
      // insertAfter lands inside the element, not after it.
      ["<div>x<xmp>", "<p>f</p>", ["insertAfter"]],
      ["<div>x<textarea>", "<p>f</p>", ["insertAfter"]],
    ];
    for (const [html, fragment, actions] of cases) {
      const [block] = listBlocks(html);
      expect(block, `no listed block in ${html}`).toBeDefined();
      for (const action of actions) {
        const { outcome, refused } = patchOrRefused(html, {
          address: block?.address ?? "",
          action,
          html: fragment,
        });
        expect(refused, `${action} ${fragment} on ${html}`).toBe(true);
        expect(outcome).toBeUndefined();
      }
    }
  });

  it("should accept a fostered block whose splice is reparse-exact", () => {
    // The fostered <pre> sits inside the table's span but owns exactly `<pre attr="v"></pre>`:
    // removing it re-parses to the original tree minus the pre — the oracle accepts.
    const html = '<html><body><footer><thead>x</thead><table><pre attr="v"></pre></body></html>';
    const [block] = listBlocks(html);
    expect(block?.tag).toBe("pre");
    const outcome = applyBlockPatch(html, {
      address: block?.address ?? "",
      action: "delete",
    });
    expect(outcome.html).toBe("<html><body><footer><thead>x</thead><table></body></html>");
  });

  it("should never refuse a well-formed document — zero oracle refusals on the corpus", () => {
    const corpus: readonly string[] = [
      "<!DOCTYPE html><html><body><article><h1>Title</h1><p>one</p><ul><li>a</li></ul><p>two</p></article></body></html>",
      "<div><p>a</p><p>b</p></div><section><ul><li>x</li><li>y</li></ul></section>",
      "<!DOCTYPE html><html><head><title>t</title></head><body><article><h1>T</h1><p>a<b>b</b>c</p><pre>code</pre></article></body></html>",
      "<dl><dt>t1</dt><dd>d1</dd><dt>t2</dt><dd><p>nested</p></dd></dl>",
      "<figure><img src=x><figcaption>cap</figcaption></figure><blockquote><p>q</p></blockquote>",
      "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table><details><summary>s</summary><p>d</p></details>",
      "<p>para<div>indiv</div>",
      "<article><p>one<p>two<div>three",
    ];
    for (const html of corpus) {
      for (const block of listBlocks(html)) {
        const { outcome, refused } = patchOrRefused(html, {
          address: block.address,
          action: "delete",
        });
        expect(refused).toBe(false);
        expect(outcome?.html).toBe(`${html.slice(0, block.start)}${html.slice(block.end)}`);
      }
    }
  });

  it("should never refuse a safe write on a well-formed document — zero false refusals", () => {
    // Safe fragments: a same-shape block (`<p>` where a block child is legal) and an
    // inline-only fragment (`<span>` lands anywhere the parser keeps it). A refusal
    // here would be the write-side oracle over-firing on a correct write.
    const corpus: readonly string[] = [
      "<!DOCTYPE html><html><body><article><h1>Title</h1><p>one</p><ul><li>a</li></ul><p>two</p></article></body></html>",
      "<div><p>a</p><p>b</p></div><section><ul><li>x</li><li>y</li></ul></section>",
      "<!DOCTYPE html><html><head><title>t</title></head><body><article><h1>T</h1><p>a<b>b</b>c</p><pre>code</pre></article></body></html>",
      "<figure><img src=x><figcaption>cap</figcaption></figure><blockquote><p>q</p></blockquote>",
      "<p>para<div>indiv</div>",
      "<article><p>one<p>two<div>three",
    ];
    for (const html of corpus) {
      for (const block of listBlocks(html)) {
        for (const [action, fragment] of [
          ["replace", "<p>r</p>"],
          ["insertBefore", "<span>f</span>"],
          ["insertAfter", "<span>f</span>"],
        ] as const) {
          const { outcome, refused } = patchOrRefused(html, {
            address: block.address,
            action,
            html: fragment,
          });
          expect(refused, `${action} ${fragment} on ${html}`).toBe(false);
          expect(outcome).toBeDefined();
        }
      }
    }
  });
});
