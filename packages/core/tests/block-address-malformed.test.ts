// This layer covers block addresses on malformed/edge-input HTML: unclosed tags, implied
// closes, foster-parented tables, BOM/CRLF byte shapes, and a 10 MB document bound.

import { describe, expect, it } from "vitest";

import { applyBlockPatch, listBlocks, resolveAddress } from "../src/ops/block-address";

/** Milliseconds of this process's own CPU time — scheduling stalls don't inflate it. */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

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

  it("should not let an unclosed block's range absorb ancestor end tags", () => {
    // parse5 stretches an unclosed element's end past `</body>`/`</html>`; the patchable
    // range must stop at the block's own subtree.
    const html = "<body><li>a<li>b</body>";
    const [first, second] = listBlocks(html);
    expect(html.slice(second?.start ?? 0, second?.end ?? 0)).toBe("<li>b");
    const outcome = applyBlockPatch(html, {
      address: second?.address ?? "",
      action: "delete",
    });
    expect(outcome.html).toBe("<body><li>a</body>");
    expect(first?.tag).toBe("li");
  });

  it("should land insertAfter before the ancestor end tag of an unclosed block", () => {
    const html = "<body><p>x</body>";
    const [block] = listBlocks(html);
    expect(html.slice(block?.start ?? 0, block?.end ?? 0)).toBe("<p>x");
    const outcome = applyBlockPatch(html, {
      address: block?.address ?? "",
      action: "insertAfter",
      html: "<p>y</p>",
    });
    expect(outcome.html).toBe("<body><p>x<p>y</p></body>");
  });

  it("should clamp a fostered block's range inside its container's end tag", () => {
    // The <p> is foster-parented out of <table>, but its bytes sit inside the table's span;
    // the range must still end before `</table>`, not run to `</body>`.
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

  it("should clamp an unclosed block before trailing text and ancestor end tags", () => {
    const html = "<body><ul><li>a<li>b</ul>TRAIL<li>c</body>";
    const blocks = listBlocks(html);
    const last = blocks[blocks.length - 1];
    expect(html.slice(last?.start ?? 0, last?.end ?? 0)).toBe("<li>c");
    const outcome = applyBlockPatch(html, {
      address: last?.address ?? "",
      action: "delete",
    });
    expect(outcome.html).toBe("<body><ul><li>a<li>b</ul>TRAIL</body>");
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

  it("should list blocks on a 10 MB document in bounded CPU time", { timeout: 120_000 }, () => {
    const section =
      "<section><h2>标题标题标题标题</h2><p>" +
      "正文正文正文正文正文正文正文正文正文正文正文正文".repeat(8) +
      "</p><p>tail tail tail tail</p></section>";
    // SELECTOR_LIMITS.nth caps :nth-of-type at 9999, so one parent can't hold ≥10⁴ same-tag
    // siblings — group sections under wrapper divs (200 each, nth stays in range) instead.
    const group = `<div>${section.repeat(200)}</div>`;
    const repeat = Math.ceil((10 * 1024 * 1024) / group.length);
    const html = `<!DOCTYPE html><html><body><article>${group.repeat(repeat)}</article></body></html>`;
    expect(html.length).toBeGreaterThanOrEqual(10 * 1024 * 1024);

    const start = cpuMs();
    const blocks = listBlocks(html);
    const listCost = cpuMs() - start;

    const resolveStart = cpuMs();
    const last = blocks[blocks.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) return;
    expect(resolveAddress(html, last.address)).toEqual({ ok: true, block: last });
    const resolveCost = cpuMs() - resolveStart;

    // The whole doc is one O(n) scan each; 10 MB stays far under the test timeout.
    // (Reference: same-machine html-perf bounds parse+inject around single-digit seconds.)
    expect(listCost).toBeLessThan(15_000);
    expect(resolveCost).toBeLessThan(15_000);
    expect(blocks.length).toBeGreaterThan(100);
  });
});
