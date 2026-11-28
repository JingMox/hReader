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

  it("should refuse every action on a listed block whose splice is not reparse-exact", () => {
    // `<p>x<` is listed — the trailing `<` is an owned literal-text byte — but removing
    // its range leaves "" while the tree minus the block is the scaffold: not exact.
    const html = "<p>x<";
    const [block] = listBlocks(html);
    expect(block?.tag).toBe("p");
    for (const request of [
      { address: block?.address ?? "", action: "delete" },
      { address: block?.address ?? "", action: "replace", html: "<p>r</p>" },
      { address: block?.address ?? "", action: "insertBefore", html: "<p>b</p>" },
      { address: block?.address ?? "", action: "insertAfter", html: "<p>a</p>" },
    ] as const) {
      const { outcome, refused } = patchOrRefused(html, request);
      expect(refused).toBe(true);
      expect(outcome).toBeUndefined();
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
});
