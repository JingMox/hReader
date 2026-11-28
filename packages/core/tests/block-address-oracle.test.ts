// This layer covers the D60 patch-time oracle: listing is heuristic — a listed block's
// range can still hide unowned bytes — so before ANY write the oracle re-parses the
// byte-splice and compares it against the original tree minus the block's subtree.
// Only when the two sides agree byte-for-byte may the write happen; anything else is
// `target_moved`. Refused or exact, never corrupt.

import {
  parse as parse5,
  parseFragment as parse5Fragment,
  type DefaultTreeAdapterTypes,
} from "parse5";
import { describe, expect, it } from "vitest";

import {
  applyBlockPatch,
  listBlocks,
  type BlockPatchOutcome,
  type BlockPatchRequest,
} from "../src/ops/block-address";

type P5Node = DefaultTreeAdapterTypes.Node;
type P5Element = DefaultTreeAdapterTypes.Element;

/** Children in document order — `<template>` parents its content fragment, not childNodes. */
const p5Children = (node: P5Node): readonly P5Node[] => {
  if ("content" in node) return node.content.childNodes;
  if ("childNodes" in node) return node.childNodes;
  return [];
};

/**
 * The block's slot in a raw parse5 tree, rebuilt independently: the element whose
 * source extent is exactly `[start, end)`, its parent, and its child index.
 */
interface RawSlot {
  readonly node: P5Element;
  readonly parent: P5Node;
  readonly index: number;
}

const findRawSlot = (root: P5Node, start: number, end: number): RawSlot | undefined => {
  const pending: { node: P5Node; parent: P5Node; index: number }[] = p5Children(root).map(
    (node, index) => ({ node, parent: root, index }),
  );
  // The queue grows while it is walked — for-of still visits pushed entries.
  for (const candidate of pending) {
    if ("tagName" in candidate.node) {
      const location = candidate.node.sourceCodeLocation;
      if (
        location?.startTag !== undefined &&
        location.startOffset === start &&
        location.endOffset === end
      ) {
        return { node: candidate.node, parent: candidate.parent, index: candidate.index };
      }
      for (const [index, child] of p5Children(candidate.node).entries()) {
        pending.push({ node: child, parent: candidate.node, index });
      }
    }
  }
  return undefined;
};

const p5AttrsEq = (left: P5Element, right: P5Element): boolean => {
  const encode = (node: P5Element): string =>
    node.attrs.map((attr) => `${attr.name}\0${attr.value}`).join("\0");
  return encode(left) === encode(right);
};

/** Adjacent text siblings folded into one run — a splice stitches neighbour texts into one node. */
const p5Merged = (children: readonly P5Node[]): readonly P5Node[] => {
  const merged: P5Node[] = [];
  for (const child of children) {
    const last = merged[merged.length - 1];
    if (child.nodeName === "#text" && last?.nodeName === "#text") {
      const mergedText: DefaultTreeAdapterTypes.TextNode = {
        ...(last as DefaultTreeAdapterTypes.TextNode),
        value: `${(last as DefaultTreeAdapterTypes.TextNode).value}${(child as DefaultTreeAdapterTypes.TextNode).value}`,
      };
      merged[merged.length - 1] = mergedText;
    } else {
      merged.push(child);
    }
  }
  return merged;
};

interface RawWound {
  readonly parent: P5Node;
  readonly children: readonly P5Node[];
}

const p5NodeEq = (left: P5Node, right: P5Node, wound: RawWound): boolean => {
  if (left.nodeName !== right.nodeName) return false;
  const atWound = left === wound.parent;
  const a = atWound ? p5Merged(wound.children) : p5Children(left);
  const b = atWound ? p5Merged(p5Children(right)) : p5Children(right);
  if (left.nodeName === "#text") {
    return (
      (left as DefaultTreeAdapterTypes.TextNode).value ===
      (right as DefaultTreeAdapterTypes.TextNode).value
    );
  }
  if (left.nodeName === "#comment") {
    return (
      (left as DefaultTreeAdapterTypes.CommentNode).data ===
      (right as DefaultTreeAdapterTypes.CommentNode).data
    );
  }
  if (left.nodeName === "#documentType") {
    const self = left as DefaultTreeAdapterTypes.DocumentType;
    const other = right as DefaultTreeAdapterTypes.DocumentType;
    return (
      self.name === other.name &&
      self.publicId === other.publicId &&
      self.systemId === other.systemId
    );
  }
  if ("tagName" in left) {
    const other = right as P5Element;
    if (left.tagName !== other.tagName || !p5AttrsEq(left, other)) return false;
  }
  return (
    a.length === b.length &&
    a.every((node, index) => {
      const other = b[index];
      return other !== undefined && p5NodeEq(node, other, wound);
    })
  );
};

/**
 * The D68 judgment, rebuilt independently on raw parse5 trees: the written result must
 * equal the original tree except exactly at the block's slot, where the expected child
 * list (the block cut, or the fragment's top-level nodes spliced per action) appears.
 * Checked in both scripting modes — a `<noscript>`-borne element does not exist when
 * scripting is on, so a write touching it cannot be verified and must be refused.
 */
const rawJudged = (
  html: string,
  result: string,
  start: number,
  end: number,
  expectedKids: (slot: RawSlot, frag: readonly P5Node[]) => readonly P5Node[],
  fragHtml: string | undefined,
): boolean =>
  [false, true].every((scriptingEnabled) => {
    const original = parse5(html, { sourceCodeLocationInfo: true, scriptingEnabled });
    const written = parse5(result, { sourceCodeLocationInfo: true, scriptingEnabled });
    const slot = findRawSlot(original, start, end);
    if (slot === undefined) return false;
    const fragment =
      fragHtml === undefined
        ? []
        : parse5Fragment(fragHtml, { sourceCodeLocationInfo: true, scriptingEnabled }).childNodes;
    const kids = expectedKids(slot, fragment);
    return p5NodeEq(original, written, { parent: slot.parent, children: kids });
  });

/** Delete judged on raw trees: the splice must be the original minus the block, exactly. */
const deleteJudgedRaw = (html: string, result: string, start: number, end: number): boolean =>
  rawJudged(
    html,
    result,
    start,
    end,
    (slot) => {
      const kids = p5Children(slot.parent);
      return [...kids.slice(0, slot.index), ...kids.slice(slot.index + 1)];
    },
    undefined,
  );

/** A write judged on raw trees: the fragment's top-level nodes at the block's slot. */
const writeJudgedRaw = (
  html: string,
  result: string,
  start: number,
  end: number,
  action: "replace" | "insertBefore" | "insertAfter",
  fragHtml: string,
): boolean =>
  rawJudged(
    html,
    result,
    start,
    end,
    (slot, frag) => {
      const kids = p5Children(slot.parent);
      if (action === "replace") {
        return [...kids.slice(0, slot.index), ...frag, ...kids.slice(slot.index + 1)];
      }
      if (action === "insertBefore") {
        return [...kids.slice(0, slot.index), ...frag, slot.node, ...kids.slice(slot.index + 1)];
      }
      return [...kids.slice(0, slot.index + 1), ...frag, ...kids.slice(slot.index + 1)];
    },
    fragHtml,
  );

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
        // Accepted: only the block's own bytes went, and the splice re-parses on RAW
        // parse5 trees — both scripting modes — to exactly the original tree minus
        // the block's subtree.
        expect(outcome?.html).toBe(stripped);
        expect(deleteJudgedRaw(html, stripped, block.start, block.end)).toBe(true);
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

  it("should refuse when the splice's residue evaporates on re-parse", () => {
    // Whitespace before any markup is dropped by the parser ("before html" insertion
    // mode), and an ignored `</…` end tag at EOF produces no node: deleting the block
    // leaves bytes that re-parse to LESS than the original tree minus the block —
    // the pre-write oracle catches it for every action.
    for (const html of [
      "<div>x</div>\n",
      "<div>x</div>\n</ar",
      "<blockquote>x</blockquote>\n</ar",
    ]) {
      const [block] = listBlocks(html);
      expect(block).toBeDefined();
      for (const action of ["delete", "replace", "insertBefore", "insertAfter"] as const) {
        const { refused } = patchOrRefused(html, {
          address: block?.address ?? "",
          action,
          ...(action === "delete" ? {} : { html: "<p>f</p>" }),
        });
        expect(refused, `${action} on ${JSON.stringify(html)}`).toBe(true);
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
      number,
    ])[] = [
      // Scope-close: an li/dd/dt/button start tag inside the open li/dt/dd/button
      // scope closes the context and reparents the fragment — and the original
      // block's bytes end up owned by a different parent.
      [
        "<ul><li><div><p>x</p></div></li></ul>",
        "<li>f</li>",
        ["insertBefore", "insertAfter", "replace"],
        0,
      ],
      [
        "<dl><dt><div><p>x</p></div></dt></dl>",
        "<dd>f</dd>",
        ["insertBefore", "insertAfter", "replace"],
        0,
      ],
      [
        "<dl><dd><div><p>x</p></div></dd></dl>",
        "<dt>f</dt>",
        ["insertBefore", "insertAfter", "replace"],
        0,
      ],
      [
        "<button><div><p>x</p></div></button>",
        "<button>f</button>",
        ["insertBefore", "insertAfter", "replace"],
        0,
      ],
      // Adoption agency: a formatting element inside its own scope is removed and
      // reparented — replace goes through the same split as the inserts.
      ["<a><div><p>x</p></div></a>", "<a>f</a>", ["insertBefore", "insertAfter", "replace"], 0],
      [
        "<nobr><div><p>x</p></div></nobr>",
        "<nobr>f</nobr>",
        ["insertBefore", "insertAfter", "replace"],
        0,
      ],
      // A `<form>` inside a form is dropped by the parser; its children leak.
      [
        "<form><div><p>x</p></div></form>",
        "<form><p>f</p></form>",
        ["insertBefore", "insertAfter", "replace"],
        0,
      ],
      // Unclosed raw text swallows a fragment written at the range's end offset —
      // insertAfter lands inside the element, not after it.
      ["<div>x<xmp>", "<p>f</p>", ["insertAfter"], 0],
      ["<div>x<textarea>", "<p>f</p>", ["insertAfter"], 0],
      // The fostered `p` is a body child inside the second table's span — a write at
      // its slot re-parses as table content (text/element kind divergence), not the
      // body's child list.
      ["<table></b><b><table><p>x</p>", "<p>f</p>", ["insertBefore", "insertAfter", "replace"], 0],
      // D68: the normalized model hoisted block content out of still-open elements,
      // which let the old oracle verify a tree the bytes never produce. On raw parse5
      // these writes land the fragment inside the wrong element.
      // `<button>` does not close a still-open `<p>` — insertAfter lands inside it.
      [
        "<!DOCTYPE html><article><p>text</p><p>after",
        "<button><div>f</div></button>",
        ["insertAfter"],
        1,
      ],
      // A fostered `p` is a body child whose bytes sit inside the table — any write
      // at its slot re-parses inside the table context.
      [
        "<body><table><p>x</table></body>",
        "<template><p>f</p></template>",
        ["insertBefore", "insertAfter", "replace"],
        0,
      ],
      // Quirks mode: `<table>` does not close `<p>` — the table lives inside p(a),
      // and replacing it re-parses with the fragment outside B's real parent.
      [
        "<p>a<table><tr><td>b</td></tr></table><p>c",
        "<p>f</p>",
        ["insertBefore", "insertAfter", "replace"],
        0,
      ],
      [
        "<p>first<p>second<p>third",
        "<table><tr><td>f</td></tr></table>",
        ["insertBefore", "insertAfter", "replace"],
        2,
      ],
      // Scope boundaries: select/object/marquee nest inside a still-open `<p>` —
      // insertAfter at the block's end lands inside them, not after the block.
      ["<p>x<select>", "<option>f</option>", ["insertAfter"], 0],
      ["<p>x<object>", "<div>f</div>", ["insertAfter"], 0],
      ["<p>x<marquee>", "<div>f</div>", ["insertAfter"], 0],
      // `<plaintext>` swallows all tail bytes as text — the fragment lands as raw text.
      ["<p>b<plaintext>c", "<i>f</i>", ["insertAfter"], 0],
      // A `<select>` fragment spliced into foreign content lands as `svg:select` —
      // not the HTML element its own parse produced. The block's parent is `svg`,
      // so every write at the slot produces a namespaced node (found by the corpus
      // fuzz; an HtmlNode model cannot see namespace, the raw tree keeps it).
      [
        "<svg><aside></aside><p></p>",
        "<select><option>f</option></select>",
        ["insertBefore", "insertAfter", "replace"],
        0,
      ],
    ];
    for (const [html, fragment, actions, blockIndex] of cases) {
      const block = listBlocks(html)[blockIndex];
      expect(block, `no listed block #${String(blockIndex)} in ${html}`).toBeDefined();
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

  it("should refuse every action on a block whose raw element depends on the scripting mode", () => {
    // With scripting off, `<noscript>` parses its content as HTML and the `p` is a
    // real element; with scripting on, the content is raw text and no such element
    // exists. A write that only exists in one of the two real DOMs cannot be
    // verified — refused for all four actions.
    const html = "<body><noscript><p>x</p></noscript></body>";
    const [block] = listBlocks(html);
    expect(block).toBeDefined();
    for (const action of ["delete", "replace", "insertBefore", "insertAfter"] as const) {
      const { outcome, refused } = patchOrRefused(html, {
        address: block?.address ?? "",
        action,
        ...(action === "delete" ? {} : { html: "<p>f</p>" }),
      });
      expect(refused, `${action} on ${html}`).toBe(true);
      expect(outcome).toBeUndefined();
    }
  });

  it("should judge each scripting mode on its own raw tree beside a mode-divergent subtree", () => {
    // The `<noscript>` subtree parses as elements with scripting off and raw text
    // with it on — the two raw trees genuinely differ there, so judging either
    // mode on the other's parse changes the verdict. The block outside the
    // `<noscript>` exists in both DOMs and must still patch cleanly.
    const html = "<body><noscript><p>alt</p></noscript><p>real</p></body>";
    const block = listBlocks(html).find(
      (candidate) => html.slice(candidate.start, candidate.end) === "<p>real</p>",
    );
    expect(block).toBeDefined();
    const { outcome, refused } = patchOrRefused(html, {
      address: block?.address ?? "",
      action: "replace",
      html: "<p>r2</p>",
    });
    expect(refused).toBe(false);
    expect(outcome?.html).toBe("<body><noscript><p>alt</p></noscript><p>r2</p></body>");
    expect(
      writeJudgedRaw(
        html,
        outcome?.html ?? "",
        block?.start ?? -1,
        block?.end ?? -1,
        "replace",
        "<p>r2</p>",
      ),
    ).toBe(true);
  });

  it("should verify a mode-divergent fragment against each mode's own expected shape", () => {
    // A `<noscript>` fragment's subtree differs between scripting modes (element
    // children vs raw text — a bare top-level `<noscript>` is a head element and
    // not a legal fragment root, so it sits inside a `<div>`), so the expected
    // wound children must come from the same mode's fragment parse as the
    // re-parsed result — otherwise the write is judged against a tree the bytes
    // never produce.
    const html = "<body><p>real</p></body>";
    const [block] = listBlocks(html);
    const fragment = "<div><noscript><p>f</p></noscript></div>";
    const { outcome, refused } = patchOrRefused(html, {
      address: block?.address ?? "",
      action: "insertAfter",
      html: fragment,
    });
    expect(refused).toBe(false);
    expect(outcome?.html).toBe("<body><p>real</p><div><noscript><p>f</p></noscript></div></body>");
    expect(
      writeJudgedRaw(
        html,
        outcome?.html ?? "",
        block?.start ?? -1,
        block?.end ?? -1,
        "insertAfter",
        fragment,
      ),
    ).toBe(true);
  });

  it("should accept a quirks-sensitive write when the doctype is limited-quirks", () => {
    // `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">` is limited-quirks — the
    // implied-end-tag rules still apply, so `<table>` closes `<p>` and the table is
    // a body-level block whose replacement lands exactly at its slot (contrast with
    // the full-quirks document above, which refuses).
    const html =
      '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><p>a<table><tr><td>b</td></tr></table><p>c';
    const block = listBlocks(html).find((candidate) => candidate.tag === "table");
    expect(block).toBeDefined();
    const { outcome, refused } = patchOrRefused(html, {
      address: block?.address ?? "",
      action: "replace",
      html: "<p>f</p>",
    });
    expect(refused).toBe(false);
    expect(outcome).toBeDefined();
    expect(
      outcome &&
        writeJudgedRaw(
          html,
          outcome.html,
          block?.start ?? -1,
          block?.end ?? -1,
          "replace",
          "<p>f</p>",
        ),
    ).toBe(true);
  });

  it("should accept foreign-content break-outs that land at the block's real slot", () => {
    // A block fostered out of svg/math is body's child with a span inside the foreign
    // element's bytes: writing a fragment there breaks out of the foreign element on
    // re-parse — but it breaks to exactly the block's slot at body level, so the
    // write is spec-correct and accepted.
    const cases: readonly (readonly [string, string])[] = [
      ["<svg><p>x</p></svg>", "<p>f</p>"],
      ["<svg><div><p>x</p></div></svg>", "<blockquote><p>f</p></blockquote>"],
      ["<math><p>x</p></math>", "<table><tr><td>f</td></tr></table>"],
      ["<svg><foreignObject><p>x</p></foreignObject></svg>", "<p>f</p>"],
    ];
    for (const [html, fragment] of cases) {
      const [block] = listBlocks(html);
      for (const action of ["replace", "insertBefore", "insertAfter"] as const) {
        const { outcome, refused } = patchOrRefused(html, {
          address: block?.address ?? "",
          action,
          html: fragment,
        });
        expect(refused, `${action} ${fragment} on ${html}`).toBe(false);
        expect(outcome).toBeDefined();
      }
    }
  });

  it("should judge a namespaced splice by where the fragment actually lands", () => {
    // `<p>` is a foreign-content breakout tag — in `<svg><aside></aside><p></p>`
    // the p is a body child, not an svg one. A `<select>` spliced BEFORE it stays
    // inside `<svg>` (svg-namespaced — refused), but insertAfter lands at body
    // level where the select is an ordinary HTML element (accepted).
    const html = "<svg><aside></aside><p></p>";
    const block = listBlocks(html)[1];
    expect(block?.tag).toBe("p");
    for (const action of ["replace", "insertBefore"] as const) {
      const { refused } = patchOrRefused(html, {
        address: block?.address ?? "",
        action,
        html: "<select><option>f</option></select>",
      });
      expect(refused, `${action} on ${html}`).toBe(true);
    }
    const { outcome, refused } = patchOrRefused(html, {
      address: block?.address ?? "",
      action: "insertAfter",
      html: "<select><option>f</option></select>",
    });
    expect(refused).toBe(false);
    expect(outcome?.html).toBe(`${html}<select><option>f</option></select>`);
    expect(
      outcome !== undefined &&
        writeJudgedRaw(
          html,
          outcome.html,
          block?.start ?? -1,
          block?.end ?? -1,
          "insertAfter",
          "<select><option>f</option></select>",
        ),
    ).toBe(true);
  });

  it("should patch a shallow block inside a document whose siblings are arbitrarily deep", () => {
    // The oracle walks the whole tree pair-wise — a deep sibling subtree must not
    // overflow it. Iterative traversal keeps a listed block patchable no matter
    // how deep its neighbors nest (the corpus's depth-stress documents).
    const deep = `${"<div>".repeat(8000)}${"</div>".repeat(8000)}<p>x</p>`;
    const [block] = listBlocks(deep);
    expect(block?.tag).toBe("p");
    const deleted = applyBlockPatch(deep, { address: block?.address ?? "", action: "delete" });
    expect(deleted.html).toBe(deep.slice(0, -8));
    const { outcome, refused } = patchOrRefused(deep, {
      address: block?.address ?? "",
      action: "replace",
      html: "<p>y</p>",
    });
    expect(refused).toBe(false);
    expect(outcome?.html).toBe(`${deep.slice(0, -8)}<p>y</p>`);
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
    expect(deleteJudgedRaw(html, outcome.html, block?.start ?? -1, block?.end ?? -1)).toBe(true);
  });

  // The false-refusal regression corpus: well-formed documents whose listed blocks
  // must accept every benign op — a refusal here is the raw oracle over-firing.
  const WELL_FORMED: readonly string[] = [
    "<!DOCTYPE html><html><body><article><h1>Title</h1><p>one</p><ul><li>a</li></ul><p>two</p></article></body></html>",
    "<div><p>a</p><p>b</p></div><section><ul><li>x</li><li>y</li></ul></section>",
    "<!DOCTYPE html><html><head><title>t</title></head><body><article><h1>T</h1><p>a<b>b</b>c</p><pre>code</pre></article></body></html>",
    "<dl><dt>t1</dt><dd>d1</dd><dt>t2</dt><dd><p>nested</p></dd></dl>",
    "<figure><img src=x><figcaption>cap</figcaption></figure><blockquote><p>q</p></blockquote>",
    "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table><details><summary>s</summary><p>d</p></details>",
    "<p>para<div>indiv</div>",
    "<article><p>one<p>two<div>three</div>",
    "<ol><li>a<li>b<li>c</ol>",
    "<section><h2>h</h2><p>a</p><p>b</p><footer>f</footer></section>",
    "<body><table><caption>cap</caption><colgroup><col><col></colgroup><tbody><tr><td>x</td><td>y</td></tr><tr><td>u</td><td>v</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table></body>",
    "<main><nav><ul><li>a</li><li>b</li></ul></nav><article><p>body</p></article></main>",
    "<div><pre>line1\nline2</pre><code>c</code><hr><p>after</p></div>",
    "<body><dl><dt>a</dt><dd>x</dd></dl><ul><li><dl><dt>i</dt><dd>j</dd></dl></li></ul></body>",
    "<body><template><div><p>x</p></div></template><p>after</p></body>",
    "<body><svg><foreignObject><p>x</p><p>y</p></foreignObject></svg><div>after</div></body>",
    "<body><iframe srcdoc=x></iframe><p>after</p></body>",
    "<div><p>a<!-- c -->b</p><ul><li>x<!-- in --></li></ul></div>",
    "<body><hgroup><h1>a</h1><p>b</p></hgroup><aside><p>c</p></aside></body>",
    "<body><menu><li>a</li></menu><fieldset><legend>l</legend><p>x</p></fieldset></body>",
    "<body><address>a</address><output>o</output><meter>m</meter><progress>p</progress></body>",
    "<body><section><article><p>a</p></article><aside><p>b</p></aside></section></body>",
    "<body><ruby><rt>r</rt></ruby><ruby><rb>b</rb><rt>t</rt></ruby><p>after</p></body>",
    "<body><video><source src=x><track src=y></video><p>after</p></body>",
    "<body><details open><summary>s</summary><div><p>d</p></div></details><dialog>d</dialog><p>end</p></body>",
    "<article><p>alpha</p>between<p>beta</p></article>",
  ];

  /** The block's parent element tag, read back out of its selector address. */
  const parentTagOf = (address: string): string => {
    const steps = address.slice(address.indexOf(":") + 1, address.indexOf("@")).split(" > ");
    const step = steps[steps.length - 2] ?? "body";
    return step.split(":")[0] ?? "body";
  };

  /**
   * A fragment that legally lands at this block's slot: same-tag for replace (the
   * slot held exactly such an element; `table` needs structure — bare text inside a
   * table fosters out and breaks the single-root rule) and a container-legal element
   * for the two inserts — `<dl>` only holds dt/dd, lists only hold li, hgroup only
   * holds headings.
   */
  const legalReplace = (tag: string): string =>
    tag === "table" ? "<table><tr><td>r</td></tr></table>" : `<${tag}>r</${tag}>`;

  const legalInsert = (parentTag: string): string =>
    parentTag === "dl"
      ? "<dd>f</dd>"
      : parentTag === "ul" || parentTag === "ol" || parentTag === "menu"
        ? "<li>f</li>"
        : parentTag === "hgroup"
          ? "<h2>f</h2>"
          : "<div>f</div>";

  it("should never refuse a delete on a well-formed document — zero oracle refusals", () => {
    for (const html of WELL_FORMED) {
      for (const block of listBlocks(html)) {
        const { outcome, refused } = patchOrRefused(html, {
          address: block.address,
          action: "delete",
        });
        expect(refused, `delete on ${html} block ${block.address}`).toBe(false);
        const stripped = `${html.slice(0, block.start)}${html.slice(block.end)}`;
        expect(outcome?.html).toBe(stripped);
        expect(deleteJudgedRaw(html, stripped, block.start, block.end)).toBe(true);
      }
    }
  });

  it("should never refuse a benign write on a well-formed document — zero false refusals", () => {
    // Benign ops: replace with a same-tag element, and a container-legal insert on
    // either side — each lands at the block's slot in any context. Every accepted
    // write must additionally survive the independent raw-parse5 judgment.
    for (const html of WELL_FORMED) {
      for (const block of listBlocks(html)) {
        const insert = legalInsert(parentTagOf(block.address));
        for (const [action, fragment] of [
          ["replace", legalReplace(block.tag)],
          ["insertBefore", insert],
          ["insertAfter", insert],
        ] as const) {
          const { outcome, refused } = patchOrRefused(html, {
            address: block.address,
            action,
            html: fragment,
          });
          expect(refused, `${action} ${fragment} on ${html} block ${block.address}`).toBe(false);
          expect(outcome).toBeDefined();
          if (outcome !== undefined) {
            expect(
              writeJudgedRaw(html, outcome.html, block.start, block.end, action, fragment),
            ).toBe(true);
          }
        }
      }
    }
  });
});
