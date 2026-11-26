// `nodeSliceOf`: cuts one node's source out of the `/s/:docId` source bytes (core has no readNode route —
// both the annotation flow and `hreader_read_node` depend on it). Nested same-name tags pair by depth;
// the first `</p>` cannot end the outer one.

import { describe, expect, it } from "vitest";

import { nodeSliceOf } from "../pi-hreader.ts";

const DOC =
  '<article data-hr-id="root">' +
  '<section data-hr-id="s1">' +
  '<p data-hr-id="p1">外层<p data-hr-id="p2">内层</p>尾巴</p>' +
  '<img data-hr-id="i1" src="a.png">' +
  '<br data-hr-id="b1">' +
  "<span data-hr-id='q1'>单引号</span>" +
  "</section>" +
  "</article>";

describe("nodeSliceOf pairing", () => {
  it("should pair nested same-name tags by depth (an inner `</p>` cannot end the outer)", () => {
    expect(nodeSliceOf(DOC, "p1")).toBe(
      '<p data-hr-id="p1">外层<p data-hr-id="p2">内层</p>尾巴</p>',
    );
  });

  it("should slice an inner node on its own", () => {
    expect(nodeSliceOf(DOC, "p2")).toBe('<p data-hr-id="p2">内层</p>');
  });

  it("should not expect a closing tag on self-closing/void elements", () => {
    expect(nodeSliceOf(DOC, "i1")).toBe('<img data-hr-id="i1" src="a.png">');
    expect(nodeSliceOf(DOC, "b1")).toBe('<br data-hr-id="b1">');
  });

  it("should also recognize single-quoted attributes", () => {
    expect(nodeSliceOf(DOC, "q1")).toBe("<span data-hr-id='q1'>单引号</span>");
  });

  it("should map `root` to the whole `<article>` (root means the same in core's patch)", () => {
    expect(nodeSliceOf(DOC, "root")?.startsWith('<article data-hr-id="root">')).toBe(true);
    expect(nodeSliceOf(DOC, "root")?.endsWith("</article>")).toBe(true);
  });

  it("should return undefined for a missing node (the caller produces node_not_found)", () => {
    expect(nodeSliceOf(DOC, "nope")).toBeUndefined();
  });
});

describe("nodeSliceOf truncation edges", () => {
  it("should return undefined for an unclosed tag rather than half the source", () => {
    expect(nodeSliceOf('<p data-hr-id="p1">没有收尾', "p1")).toBeUndefined();
  });

  it("should return undefined when no `>` follows the closing tag (source cut mid-write), not empty-source", () => {
    // A missed `indexOf` once returned -1, `-1 + 1` made 0, and `slice(open, 0)` passed "" off as valid source.
    expect(nodeSliceOf('<p data-hr-id="p1">x</p', "p1")).toBeUndefined();
  });

  it("should return undefined for `root` when there is no `<article>`", () => {
    expect(nodeSliceOf("<div>no article</div>", "root")).toBeUndefined();
  });
});
