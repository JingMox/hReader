// This layer covers `ops/block-address`'s read half: leaf-block detection, the fingerprint
// domain (whitespace/entity normalization, skipped subtrees, CJK/emoji), address round-trips,
// malformed addresses and the relocate-on-stale-path resolution order.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SELECTOR_LIMITS } from "../src/annotations/relocate";
import { applyBlockPatch, listBlocks, resolveAddress } from "../src/ops/block-address";
import { ADDRESS_LIMIT, BLOCK_ADDRESS_TAGS } from "../src/ops/block-address/constants";
import { codeOf } from "./io/harness";

const sha1Of = (text: string): string =>
  createHash("sha1").update(text, "utf8").digest("hex").slice(0, 8);

const DOC = [
  "<!DOCTYPE html><html><body><article>",
  "<h1>Title</h1>",
  "<p>one</p>",
  "<div><p>two</p></div>",
  "<ul><li>a</li><li><p>b</p></li></ul>",
  "</article></body></html>",
].join("");

const blocksOf = (html: string) => listBlocks(html);
const tagsOf = (html: string): readonly string[] => blocksOf(html).map((block) => block.tag);

/**
 * A document whose leaf `<p>deep</p>` mints a path of exactly `pathLen` chars:
 * `body > div:nth-of-type(k) > … > p`. Each ancestor step costs
 * `3 + "div:nth-of-type(k)".length` = 20 + digits(k) ∈ [21, 24], realized by
 * k−1 empty `<div>` siblings before the chain element. Taking the most
 * ancestors (n = ⌊target/21⌋) keeps every needed digit bump at k = 10, so the
 * doc stays small enough for the instrumented mutation dry run.
 */
const deepDoc = (pathLen: number): string => {
  const target = pathLen - 8; // "body" + " > p"
  const n = Math.floor(target / 21);
  let extra = target - 21 * n;
  let html = "<body>";
  let closing = "";
  for (let index = 0; index < n; index += 1) {
    const bonus = Math.ceil(extra / (n - index)); // spread the extras as k=10 levels
    extra -= bonus;
    const k = bonus === 0 ? 2 : 10 ** bonus;
    html += `${"<div></div>".repeat(k - 1)}<div>`;
    closing += "</div>";
  }
  return `${html}<p>deep</p>${closing}</body>`;
};

describe("listBlocks · leaf-block detection", () => {
  it("should list only leaf blocks in document order", () => {
    expect(blocksOf(DOC).map((block) => block.tag)).toEqual(["h1", "p", "p", "li", "p"]);
  });

  it("should mark a container div as non-addressable but keep its inner paragraph", () => {
    expect(tagsOf("<div><div><p>x</p></div></div>")).toEqual(["p"]);
    expect(tagsOf("<div><span><p>x</p></span></div>")).toEqual(["p"]);
  });

  it("should treat an inline-only div as a block", () => {
    expect(tagsOf("<div><b>x</b><i>y</i></div>")).toEqual(["div"]);
  });

  it("should address the p inside li, not the li itself", () => {
    expect(tagsOf("<ul><li><p>x</p></li><li>y</li></ul>")).toEqual(["p", "li"]);
  });

  it("should address a whole table as one block (its internals are not blocks)", () => {
    expect(tagsOf("<table><tr><td>x</td></tr><tr><td>y</td></tr></table>")).toEqual(["table"]);
  });

  it("should address figure's figcaption and keep figure a container", () => {
    expect(tagsOf("<figure><img src=x><figcaption>cap</figcaption></figure>")).toEqual([
      "figcaption",
    ]);
  });

  it("should address dt/dd separately from their dl container", () => {
    expect(tagsOf("<dl><dt>t</dt><dd>d</dd></dl>")).toEqual(["dt", "dd"]);
  });

  // The block tag set is a contract: every member must address a leaf element carrying it.
  // (A dropped tag would promote the wrapper <div> to a leaf and the tag assert fails.)
  it.each([
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "table",
    "figure",
    "section",
    "article",
    "blockquote",
    "pre",
    "div",
    "ul",
    "ol",
    "dl",
    "dt",
    "dd",
    "header",
    "footer",
    "aside",
    "nav",
    "main",
    "figcaption",
    "details",
    "summary",
  ])("should address a leaf <%s> element", (tag) => {
    const wrapper = tag === "div" ? "section" : "div";
    expect(tagsOf(`<${wrapper}><${tag}>x</${tag}></${wrapper}>`)).toEqual([tag]);
  });

  it("should address an empty section as a leaf block", () => {
    expect(tagsOf("<section></section><p>x</p>")).toEqual(["section", "p"]);
  });

  it("should not list implicit-close split pieces: their ranges are not tag-anchored", () => {
    // Quirks <p> split by <table> (implicit-close.ts paragraphPiece): the first piece's
    // span starts at the content offset (its `<p` is excluded) and the continuation piece
    // has no start tag in the source at all — neither is byte-addressable.
    expect(tagsOf("<p>a<table><tr><td>x</td></tr></table>b")).toEqual(["table"]);
  });

  it("should not list a zero-length synthesized piece", () => {
    // The hr-id carrier emitted for `<p data-hr-id><table>` is a zero-length span with
    // no start tag of its own — not a block.
    expect(tagsOf('<p data-hr-id="p-1"><table><tr><td>x</td></tr></table>')).toEqual(["table"]);
  });

  it("should give target_moved for an address minted on a split piece", () => {
    // The piece exists in the tree (elementByPath finds it) but is not a listed block —
    // resolution falls through to the fingerprint search, which finds no unique hit.
    const html = "<p>a<table><tr><td>x</td></tr></table>b";
    expect(resolveAddress(html, `css:body > p:nth-of-type(1)@${sha1Of("a")}`)).toEqual({
      ok: false,
      code: "target_moved",
    });
  });

  it("should give start/end as the outerHTML source range", () => {
    const html = "<p>a</p>\n<p>b</p>";
    const [first, second] = blocksOf(html);
    expect(html.slice(first?.start, first?.end)).toBe("<p>a</p>");
    expect(html.slice(second?.start, second?.end)).toBe("<p>b</p>");
  });

  it("should be deterministic for the same input", () => {
    expect(listBlocks(DOC)).toEqual(listBlocks(DOC));
  });

  it("should return an empty list for an empty document", () => {
    expect(listBlocks("")).toEqual([]);
    expect(listBlocks("   \n  ")).toEqual([]);
  });
});

describe("fingerprints", () => {
  it("should be stable across whitespace differences", () => {
    const [a] = blocksOf("<p>hello   world</p>");
    const [b] = blocksOf("<p>hello\n\tworld</p>");
    const [c] = blocksOf("<p> hello  world </p>");
    expect(a?.address).toBe(b?.address);
    expect(a?.address).toBe(c?.address);
  });

  it("should hash the decoded entity text, not the source bytes", () => {
    const [a] = blocksOf("<p>a &amp; b</p>");
    const [b] = blocksOf("<p>a & b</p>");
    expect(a?.address.split("@")[1]).toBe(b?.address.split("@")[1]);
    const [c] = blocksOf("<p>a &#98;</p>");
    const [d] = blocksOf("<p>a b</p>");
    expect(c?.address.split("@")[1]).toBe(d?.address.split("@")[1]);
  });

  it("should skip script/style/template/noscript subtrees inside the block", () => {
    // The domain concatenates text nodes without separators (bodyTextOf's join("")),
    // so "x" + "y" around a skipped subtree hashes like "xy", not "x y".
    const [b] = blocksOf("<div>xy</div>");
    const [a] = blocksOf("<div>x<script>let s = 1;</script>y</div>");
    expect(a?.address.split("@")[1]).toBe(b?.address.split("@")[1]);
    const [c] = blocksOf("<div>x<style>p{}</style><template><b>t</b></template>y</div>");
    expect(c?.address.split("@")[1]).toBe(b?.address.split("@")[1]);
    const [d] = blocksOf("<div>x<noscript><b>n</b></noscript>y</div>");
    expect(d?.address.split("@")[1]).toBe(b?.address.split("@")[1]);
  });

  it("should address a <p> inside <noscript>: the scripting-off parse keeps it a real element", () => {
    // Block addresses parse with the default (no `scriptingEnabled`): patching works on
    // source structure, where noscript children are markup. The scripting-on tree used by
    // the annotation body-text domain (D54) would read <p>x</p> as raw text and no block
    // would exist here at all.
    const html = "<article><noscript><p>x</p></noscript></article>";
    const [block] = listBlocks(html);
    expect(block?.tag).toBe("p");
    expect(block?.address.split("@")[1]).toBe(sha1Of("x"));
    expect(html.slice(block?.start ?? 0, block?.end ?? 0)).toBe("<p>x</p>");
    const resolved = resolveAddress(html, block?.address ?? "");
    expect(resolved.ok).toBe(true);
  });

  it("should hash CJK and emoji text identically to ASCII rules", () => {
    const [a] = blocksOf("<p>中文  测试</p>");
    const [b] = blocksOf("<p>中文 测试</p>");
    expect(a?.address.split("@")[1]).toBe(b?.address.split("@")[1]);
    const [c] = blocksOf("<p>🧱🔥</p>");
    expect(c?.textPreview).toBe("🧱🔥");
    // Different CJK text must give a different fingerprint.
    const [d] = blocksOf("<p>中文测试</p>");
    expect(a?.address.split("@")[1]).not.toBe(d?.address.split("@")[1]);
  });

  it("should hash the exact text domain: inline element text counts, order preserved", () => {
    // The fingerprint must equal sha1 over the flattened text — pinning the value (not just
    // inequality) is what keeps the traversal honest: dropping <b>'s subtree or joining with
    // separators changes the hash.
    const [block] = blocksOf("<p>a<b>b</b>d</p>");
    expect(block?.address.split("@")[1]).toBe(sha1Of("abd"));
    const [styled] = blocksOf("<p>a<i>x</i><b>c</b>d</p>");
    expect(styled?.address.split("@")[1]).toBe(sha1Of("axcd"));
  });

  it("should give two same-text blocks the same fingerprint", () => {
    const blocks = blocksOf("<p>dup</p><div><p>dup</p></div>");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.address.split("@")[1]).toBe(blocks[1]?.address.split("@")[1]);
    expect(blocks[0]?.address).not.toBe(blocks[1]?.address);
  });
});

describe("address format", () => {
  it("should round-trip every listed address back to the same block", () => {
    for (const block of blocksOf(DOC)) {
      const resolved = resolveAddress(DOC, block.address);
      expect(resolved).toEqual({ ok: true, block });
    }
  });

  it("should use nth-of-type only past the first same-tag sibling", () => {
    const blocks = blocksOf("<p>a</p><p>b</p><p>c</p>");
    expect(blocks.map((block) => block.address.split("@")[0])).toEqual([
      "css:body > p",
      "css:body > p:nth-of-type(2)",
      "css:body > p:nth-of-type(3)",
    ]);
  });

  it("should list the same blocks as before source-ownership validation on well-formed docs", () => {
    // D58 regression pin: on ordinary well-formed input every leaf block's range was
    // already exactly its own bytes, so ownership validation changes nothing here.
    const corpus: readonly (readonly [string, readonly string[]])[] = [
      [DOC, ["h1", "p", "p", "li", "p"]],
      [
        "<div><p>a</p><p>b</p></div><section><ul><li>x</li><li>y</li></ul></section>",
        ["p", "p", "li", "li"],
      ],
      [
        "<!DOCTYPE html><html><head><title>t</title></head><body><article><h1>T</h1><p>a<b>b</b>c</p><pre>code</pre></article></body></html>",
        ["h1", "p", "pre"],
      ],
      ["<dl><dt>t1</dt><dd>d1</dd><dt>t2</dt><dd><p>nested</p></dd></dl>", ["dt", "dd", "dt", "p"]],
      [
        "<figure><img src=x><figcaption>cap</figcaption></figure><blockquote><p>q</p></blockquote>",
        ["figcaption", "p"],
      ],
      [
        "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table><details><summary>s</summary><p>d</p></details>",
        ["table", "summary", "p"],
      ],
      ["<p>para<div>indiv</div>", ["p", "div"]],
      ["<article><p>one<p>two<div>three", ["p", "p", "div"]],
    ];
    for (const [html, tags] of corpus) {
      const blocks = listBlocks(html);
      expect(blocks.map((b) => b.tag)).toEqual(tags);
      for (const block of blocks) {
        // Every listed block's range is its own outerHTML and resolves round-trip.
        const slice = html.slice(block.start, block.end);
        expect(slice.startsWith(`<${block.tag}`)).toBe(true);
        expect(resolveAddress(html, block.address)).toEqual({ ok: true, block });
      }
    }
  });

  it("should produce an address bounded by the selector limits plus the fingerprint suffix", () => {
    const nested = `${"<div>".repeat(40)}<p>x</p>${"</div>".repeat(40)}`;
    const [block] = blocksOf(nested);
    expect(block?.address.length).toBeLessThanOrEqual(4 + 1024 + 9);
  });

  it("should not list a block whose path overflows SELECTOR_LIMITS.nth", () => {
    // A block deeper than nth-of-type(9999) cannot be re-parsed — it gets no address.
    const doc = `<div>${"<p>x</p>".repeat(10_000)}<p>last</p></div>`;
    const blocks = blocksOf(doc);
    expect(blocks).toHaveLength(9_999);
    expect(blocks.every((b) => b.textPreview === "x")).toBe(true);
  });

  it("should not list a block deeper than SELECTOR_LIMITS.steps", () => {
    const depth = 65;
    const doc = `${"<div>".repeat(depth)}<p>deep</p>${"</div>".repeat(depth)}<p>ok</p>`;
    const blocks = blocksOf(doc);
    expect(blocks.map((b) => b.textPreview)).toEqual(["ok"]);
  });

  it("should still list a block at exactly SELECTOR_LIMITS.steps deep", () => {
    const depth = SELECTOR_LIMITS.steps - 2; // body + the leaf complete the 64-step path
    const doc = `${"<div>".repeat(depth)}<p>deep</p>${"</div>".repeat(depth)}`;
    expect(blocksOf(doc).some((b) => b.textPreview === "deep")).toBe(true);
  });

  it("should list a block whose path is exactly SELECTOR_LIMITS.chars but not one char over", () => {
    // expressibleSteps budgets " > step" joins: the path string itself must fit the
    // selector chars bound — undercounting would mint addresses that can never re-parse.
    const atLimit = blocksOf(deepDoc(SELECTOR_LIMITS.chars)).find(
      (b) => b.tag === "p" && b.textPreview === "deep",
    );
    expect(atLimit?.address).toHaveLength(ADDRESS_LIMIT);
    expect(
      blocksOf(deepDoc(SELECTOR_LIMITS.chars + 1)).every(
        (b) => b.tag !== "p" || b.textPreview !== "deep",
      ),
    ).toBe(true);
  });
});

describe("malformed addresses", () => {
  const doc = "<p>x</p>";

  it("should pin the block tag set and ADDRESS_LIMIT as literals", () => {
    expect([...BLOCK_ADDRESS_TAGS].sort()).toEqual([
      "article",
      "aside",
      "blockquote",
      "dd",
      "details",
      "div",
      "dl",
      "dt",
      "figcaption",
      "figure",
      "footer",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "li",
      "main",
      "nav",
      "ol",
      "p",
      "pre",
      "section",
      "summary",
      "table",
      "ul",
    ]);
    // `css:` + path (≤1024) + `@` + 8 fingerprint chars.
    expect(ADDRESS_LIMIT).toBe(4 + 1024 + 1 + 8);
  });

  it("should reject an address missing the @ separator", () => {
    expect(resolveAddress(doc, "css:body > p")).toEqual({ ok: false, code: "invalid_selector" });
  });

  it("should reject a fingerprint that is not 8 lowercase hex chars", () => {
    expect(resolveAddress(doc, "css:body > p@xyz")).toEqual({
      ok: false,
      code: "invalid_selector",
    });
    expect(resolveAddress(doc, "css:body > p@ABCDEF12")).toEqual({
      ok: false,
      code: "invalid_selector",
    });
    expect(resolveAddress(doc, "css:body > p@abcdef123")).toEqual({
      ok: false,
      code: "invalid_selector",
    });
  });

  it("should reject an over-long address", () => {
    const steps = Array.from({ length: 65 }, (_, i) => `div:nth-of-type(${String(i + 1)})`).join(
      " > ",
    );
    expect(resolveAddress(doc, `css:${steps}@abcdef12`)).toEqual({
      ok: false,
      code: "invalid_selector",
    });
    const huge = "a".repeat(1030);
    expect(resolveAddress(doc, `css:${huge}@abcdef12`)).toEqual({
      ok: false,
      code: "invalid_selector",
    });
  });

  it("should still parse an address of exactly ADDRESS_LIMIT chars", () => {
    // One char over the bound is refused; exactly at it must still parse — the failure
    // then comes from resolution (no such block), not from the syntax gate.
    const path = `body > ${"x".repeat(ADDRESS_LIMIT - 4 - 7 - 9)}`;
    const address = `css:${path}@deadbeef`;
    expect(address).toHaveLength(ADDRESS_LIMIT);
    expect(resolveAddress(doc, address)).toEqual({ ok: false, code: "target_moved" });
  });

  it("should reject an address without the css: prefix or with an unparseable path", () => {
    expect(resolveAddress(doc, "body > p@abcdef12")).toEqual({
      ok: false,
      code: "invalid_selector",
    });
    expect(resolveAddress(doc, "css:p[bad]@abcdef12")).toEqual({
      ok: false,
      code: "invalid_selector",
    });
    expect(resolveAddress(doc, "css:@abcdef12")).toEqual({ ok: false, code: "invalid_selector" });
  });

  it("should reject a non-string address", () => {
    expect(resolveAddress(doc, 42 as unknown as string)).toEqual({
      ok: false,
      code: "invalid_selector",
    });
  });
});

describe("resolveAddress · relocation", () => {
  it("should resolve an unchanged block directly by path", () => {
    const [block] = blocksOf(DOC).filter((b) => b.tag === "li");
    const resolved = resolveAddress(DOC, block?.address ?? "");
    expect(resolved).toEqual({ ok: true, block });
  });

  it("should find the block by fingerprint when it moved", () => {
    const before = "<body><p>a</p><p>target</p></body>";
    const after = "<body><div><p>target</p></div><p>a</p></body>";
    const [, target] = blocksOf(before);
    const resolved = resolveAddress(after, target?.address ?? "");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.block.tag).toBe("p");
      expect(resolved.block.textPreview).toBe("target");
      expect(after.slice(resolved.block.start, resolved.block.end)).toBe("<p>target</p>");
    }
  });

  it("should still resolve when an unrelated sibling was edited", () => {
    const before = "<p>a</p><p>target</p>";
    const [, target] = blocksOf(before);
    const after = "<p>a-edited</p><p>target</p>";
    const resolved = resolveAddress(after, target?.address ?? "");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.block.address).toBe(target?.address);
      expect(after.slice(resolved.block.start, resolved.block.end)).toBe("<p>target</p>");
    }
  });

  it("should give target_moved when the block is deleted", () => {
    const [block] = blocksOf("<p>gone</p><p>other</p>");
    expect(resolveAddress("<p>other</p>", block?.address ?? "")).toEqual({
      ok: false,
      code: "target_moved",
    });
  });

  it("should give target_moved when the block's text was edited", () => {
    const [block] = blocksOf("<p>original</p>");
    expect(resolveAddress("<p>edited</p>", block?.address ?? "")).toEqual({
      ok: false,
      code: "target_moved",
    });
  });

  it("should give target_moved when the path block was edited even if a same-fingerprint twin exists", () => {
    // D56: a fingerprint mismatch on the resolved path means the addressed block itself
    // was edited in place — the same-fingerprint twin elsewhere is a different block,
    // not the moved original. Searching would patch the wrong element.
    const [block] = blocksOf("<p>unique</p><div><p>unique</p></div>");
    const after = "<p>edited</p><div><p>unique</p></div>";
    expect(resolveAddress(after, block?.address ?? "")).toEqual({
      ok: false,
      code: "target_moved",
    });
    expect(
      codeOf(() =>
        applyBlockPatch(after, {
          address: block?.address ?? "",
          action: "replace",
          html: "<p>new</p>",
        }),
      ),
    ).toBe("target_moved");
  });

  it("should give target_moved when two identical blocks are equally close", () => {
    const [block] = blocksOf("<p>x</p>");
    const doc = "<div><p>x</p></div><section><p>x</p></section>";
    expect(resolveAddress(doc, block?.address ?? "")).toEqual({ ok: false, code: "target_moved" });
  });

  it("should pick the closest of several same-fingerprint candidates, not a tie", () => {
    // The address path `section:nth-of-type(1) > p:nth-of-type(3)` no longer exists; the
    // fingerprint twins sit at step distance 1 (section>p:nth-of-type(2)) and 2
    // (section:nth-of-type(2)>p). Only an exact distance breaks the tie in first's favor —
    // same-tag nth differences must count, and a candidate strictly worse than best must
    // not set the tie flag.
    const doc = "<body><section><p>P</p><p>Q</p></section><section><p>Q</p></section></body>";
    const resolved = resolveAddress(
      doc,
      `css:body > section:nth-of-type(1) > p:nth-of-type(3)@${sha1Of("Q")}`,
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.block.address).toContain("css:body > section > p:nth-of-type(2)@");
      expect(doc.slice(resolved.block.start, resolved.block.end)).toBe("<p>Q</p>");
    }
  });

  it("should pick the path-closest duplicate when one is nearer", () => {
    const doc = "<body><div><p>x</p></div></body>";
    const [block] = blocksOf(doc);
    // Move the document: keep a same-shape container plus a much further twin.
    const after = "<div><p>x</p></div><article><section><p>x</p></section></article>";
    const resolved = resolveAddress(after, block?.address ?? "");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(after.slice(resolved.block.start, resolved.block.end)).toBe("<p>x</p>");
      expect(resolved.block.address).toContain("css:body > div > p");
    }
  });

  it("should weigh a two-step gap above a one-step substitution", () => {
    // Fingerprint twins at [body,dd] (one substitution) and [body,div,section,p]
    // (two insertions). A zeroed first row of the distance table would make the
    // gap cost free and tie them — the bordered DP must pick the nearer twin.
    const doc = "<body><div><section><p>txt</p></section></div><dd>txt</dd></body>";
    const resolved = resolveAddress(doc, `css:body > p@${sha1Of("txt")}`);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.block.tag).toBe("dd");
      expect(doc.slice(resolved.block.start, resolved.block.end)).toBe("<dd>txt</dd>");
    }
  });

  it("should pick a later candidate when it strictly improves on the first", () => {
    // Address path `body > main > p` no longer resolves to any element, so the
    // fallback compares fingerprint twins: the article>div>p twin (distance 2) is
    // listed first, but the section>main>p twin (distance 1) must win.
    const doc = "<body><main><p>x</p></main></body>";
    const [block] = blocksOf(doc);
    const after = "<article><div><p>x</p></div></article><section><main><p>x</p></main></section>";
    const resolved = resolveAddress(after, block?.address ?? "");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.block.address).toContain("css:body > section > main > p");
      expect(after.slice(resolved.block.start, resolved.block.end)).toBe("<p>x</p>");
    }
  });

  it("should refuse a path that lands on a non-block element", () => {
    const resolved = resolveAddress("<div><em>x</em></div>", "css:body > div > em@deadbeef");
    expect(resolved).toEqual({ ok: false, code: "target_moved" });
  });
});
