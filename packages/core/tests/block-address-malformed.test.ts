// This layer covers block addresses on malformed/edge-input HTML: unclosed tags, implied
// closes, foster-parented tables, BOM/CRLF byte shapes. The 10 MB pass — structural and
// CPU-budget — lives in tests/perf/block-address.perf.test.ts: absolute time budgets must
// not run in the coverage-instrumented unit suite.

import { describe, expect, it } from "vitest";

import { applyBlockPatch, listBlocks, resolveAddress } from "../src/ops/block-address";
import { codeOf } from "./io/harness";

describe("malformed HTML", () => {
  it("should address blocks in a document with unclosed tags", () => {
    const html = "<article><p>one<p>two<div>three";
    const blocks = listBlocks(html);
    // The unclosed <p>s auto-close each other; the trailing <div> is still a leaf block.
    expect(blocks.map((b) => b.tag)).toEqual(["p", "p", "div"]);
    for (const block of blocks) {
      expect(resolveAddress(html, block.address)).toEqual({ ok: true, block });
      expect(html.slice(block.start, block.end).startsWith(`<${block.tag}>`)).toBe(true);
    }
  });

  it("should keep source offsets consistent when <p> is implicitly closed by <div>", () => {
    const html = "<p>para<div>indiv</div>";
    const blocks = listBlocks(html);
    // parse5 closes <p> before <div>: the p's outerHTML is `<p>para`, the div is `<div>indiv</div>`.
    expect(blocks).toHaveLength(2);
    expect(html.slice(blocks[0]?.start, blocks[0]?.end)).toBe("<p>para");
    expect(html.slice(blocks[1]?.start, blocks[1]?.end)).toBe("<div>indiv</div>");
    for (const block of blocks) {
      expect(resolveAddress(html, block.address)).toEqual({ ok: true, block });
    }
  });

  it("should patch a block inside a foster-parented table without losing bytes", () => {
    // No <tbody> in source: parse5 inserts one in the tree — addresses must still match
    // the actual bytes, and patching must only touch the table's own outerHTML range.
    const html = "<p>before</p><table><tr><td>cell</td></tr></table><p>after</p>";
    const blocks = listBlocks(html);
    expect(blocks.map((b) => b.tag)).toEqual(["p", "table", "p"]);
    const table = blocks[1];
    expect(table).toBeDefined();
    if (table === undefined) return;
    expect(html.slice(table.start, table.end)).toBe("<table><tr><td>cell</td></tr></table>");
    const outcome = applyBlockPatch(html, {
      address: table.address,
      action: "replace",
      html: "<pre>t</pre>",
    });
    expect(outcome.html).toBe("<p>before</p><pre>t</pre><p>after</p>");
  });

  it("should patch a block after a BOM byte-for-byte", () => {
    const inner = "<article><p>一</p><p>二</p></article>";
    const html = `\uFEFF${inner}`;
    const [first] = listBlocks(html);
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(html.slice(first.start, first.end)).toBe("<p>一</p>");
    const outcome = applyBlockPatch(html, {
      address: first.address,
      action: "replace",
      html: "<p>1</p>",
    });
    expect(outcome.html).toBe("\uFEFF<article><p>1</p><p>二</p></article>");
  });

  it("should keep CRLF bytes outside the target range untouched", () => {
    const html = "<article>\r\n<p>one</p>\r\n<p>two</p>\r\n</article>\r\n";
    const [first] = listBlocks(html);
    expect(first).toBeDefined();
    if (first === undefined) return;
    const outcome = applyBlockPatch(html, {
      address: first.address,
      action: "replace",
      html: "<p>ONE</p>",
    });
    expect(outcome.html).toBe("<article>\r\n<p>ONE</p>\r\n<p>two</p>\r\n</article>\r\n");
  });
});

describe("source ownership (D58)", () => {
  // D58: span clamping cannot work — ignored end tags carry no parse5 location, synthesized
  // ancestors truncate spans, and fostered elements land inside ranges. A block is listed
  // ONLY when its candidate range is provably owned: every start tag, end tag and text
  // byte inside it belongs to the block's own subtree. Anything else is not listed.

  it.each([
    // Unclosed elements absorbing ignored end tags — `</body>`/`</html>`/`</svg>` etc.
    // have no parse5 location, so no clamp can see them; the blocks go unlisted.
    ["<p>x</body>tail", []],
    ["<p>x</html>tail", []],
    ["<p>x<div>y</body>tail", ["p"]],
    ["<body><svg><p>x</svg></body>", []],
    ["<body><svg><foreignObject><p>x</foreignObject></svg></body>", []],
    ["<body><noscript><p>x</noscript>tail", []],
    ["<head><p>x</head><body><p>y</body>", []],
    // AAA misnesting: `</b>` inside the p's range belongs to the outer b, not the subtree.
    ["<b><p>x<i>y</b>z</p>tail", []],
    // A stray `</tr>` carries no location at all.
    ["<body><h5></tr></body>", []],
    // Zero-length template-content pieces carry no start-tag bytes of their own.
    ["<template><article>", []],
    ["<body><template><p>x", []],
    // An unclosed tail block absorbing `</body>` goes unlisted; clean siblings stay.
    ["<body><ul><li>a<li>b</ul>TRAIL<li>c</body>", ["li", "li"]],
    ["<body><li>a<li>b</body>", ["li"]],
    ["<body><p>x</body>", []],
    // The fostered <pre>'s start tag sits inside the table's range: the table goes
    // unlisted, the fostered block itself keeps exactly its own bytes and stays listed.
    ['<html><body><footer><thead>x</thead><table><pre attr="v"></pre></body></html>', ["pre"]],
    // Fostered text out of the table belongs to body — the table's range is not its own.
    ["<body><table>abc<tr><td>x</td></tr></table>", []],
    // Comments/PIs do not foster: they stay inside the element's subtree, so these bytes
    // are owned and the table keeps them.
    ["<body><table><!-- c --><tr><td>x</td></tr></table>", ["table"]],
    ["<body><table><?pi?><tr><td>x</td></tr></table>", ["table"]],
    // An ignored start tag folded into the text or dropped outright is unowned markup.
    ["<p>x<body>y", []],
    ["<p>x<td>y</p>", []],
    // `</` followed by a non-letter is a bogus comment leaf inside the block, not an
    // end-tag token — it is owned content, so the block stays listed.
    ["<p>a</2>b", ["p"]],
    // `</>` is dropped by the parser entirely — no node, no location, unowned bytes.
    ["<p></>", []],
    ["<p>a</>b", []],
    // A trailing `<` with no following byte is literal text inside an owned leaf — the
    // block keeps exactly its own bytes.
    ["<p>x<", ["p"]],
    // `</`-looking bytes inside owned comments and raw-text/RCDATA children are content:
    // the ranges are skipped, and the blocks keep exactly their own bytes.
    ["<div>x<!-- c </p> -->y</div>", ["div"]],
    ["<div><script>a</b>x</script></div>", ["div"]],
    ["<div><textarea>a</b>x</textarea></div>", ["div"]],
  ])("should list only owned blocks in %s", (html, tags) => {
    const blocks = listBlocks(html);
    expect(blocks.map((b) => b.tag)).toEqual(tags);
    for (const block of blocks) {
      expect(resolveAddress(html, block.address)).toEqual({ ok: true, block });
    }
  });

  it("should keep a fostered block's range at exactly its own bytes", () => {
    // The <p> is foster-parented out of <table>, but its bytes sit inside the table's
    // span. Its own range is still just `<p>x` — patchable; the table itself is not.
    const html = "<body><table><p>x</table></body>";
    const [block] = listBlocks(html);
    expect(block?.tag).toBe("p");
    expect(html.slice(block?.start ?? 0, block?.end ?? 0)).toBe("<p>x");
    const outcome = applyBlockPatch(html, {
      address: block?.address ?? "",
      action: "delete",
    });
    expect(outcome.html).toBe("<body><table></table></body>");
  });

  it("should give target_moved for a stale address on an unlisted block", () => {
    // The second <li> is a clean block in the minting document but goes unlisted in the
    // malformed one — its candidate range would swallow `</body>`.
    const minted = listBlocks("<body><li>a</li><li>b</li></body>")[1];
    expect(minted).toBeDefined();
    const html = "<body><li>a<li>b</body>";
    expect(resolveAddress(html, minted?.address ?? "")).toEqual({
      ok: false,
      code: "target_moved",
    });
    expect(
      codeOf(() =>
        applyBlockPatch(html, {
          address: minted?.address ?? "",
          action: "delete",
        }),
      ),
    ).toBe("target_moved");
  });

  it("should leave every outside byte identical when deleting an owned block", () => {
    const html = "<p>x<div>y</body>tail";
    const [block] = listBlocks(html);
    const outcome = applyBlockPatch(html, {
      address: block?.address ?? "",
      action: "delete",
    });
    // Only the p's own bytes go: the div and the trailing `</body>tail` are untouched.
    expect(outcome.html).toBe("<div>y</body>tail");
  });
});
