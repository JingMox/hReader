// Shared adversarial corpus: curated malformed and edge-case HTML documents.
//
// Each entry is written from the attacker's perspective — `why` names the parser stress the
// input applies, not the behavior any one feature should exhibit. Entries are inputs only;
// the judgments live in tests/adversarial checkers and in each feature's own suite.
//
// Rules for contributors: entries are append-only. A new counter-example is a new entry —
// never edit an existing `why` or weaken what an entry stresses.

import { TextDecoder } from "node:util";

/** One hostile document. `html` carries the text form; `bytes` carries encodings a JS string cannot express (invalid UTF-8). */
export type MalformedHtmlEntry = {
  /** Stable id so a failure can name the case across reports and tickets. */
  readonly id: string;
  /** What the input stresses, in one English sentence. */
  readonly why: string;
} & ({ readonly html: string } | { readonly bytes: Uint8Array });

/** Wraps `inner` in `depth` unclosed `<tag>` opens — stack-depth stress for any recursive walker (EOF implies `depth` closes). */
export const nestedTagHtml = (tag: string, depth: number, inner = ""): string =>
  `<${tag}>`.repeat(depth) + inner;

/** Wraps `inner` in `depth` balanced `<tag>…</tag>` pairs — legal deep nesting that still breaks recursive walkers. */
export const balancedNestedHtml = (tag: string, depth: number, inner = ""): string =>
  `${`<${tag}>`.repeat(depth)}${inner}${`</${tag}>`.repeat(depth)}`;

export const MALFORMED_HTML: readonly MalformedHtmlEntry[] = [
  // --- Implied end tags -----------------------------------------------------
  {
    id: "unclosed-li",
    html: "<ul><li>one<li>two<li>three</ul>",
    why: "Unclosed <li> siblings rely on the implied-end-tag rules of list scope.",
  },
  {
    id: "unclosed-p",
    html: "<p>first<p>second<p>third",
    why: "Every new <p> implicitly closes the previous open paragraph.",
  },
  {
    id: "unclosed-td-tr",
    html: "<table><tr><td>a<td>b<tr><td>c<td>d</table>",
    why: "Unclosed <td>/<tr> exercise the cell-and-row implied-end-tag rules inside table scope.",
  },
  {
    id: "unclosed-dd-dt",
    html: "<dl><dt>term<dd>def<dd>def2<dt>term2</dl>",
    why: "<dd> and <dt> implicitly close each other; mixed runs test definition-list scope.",
  },
  {
    id: "unclosed-option",
    html: "<select><option>one<option>two<option>three</select>",
    why: "Unclosed <option> elements rely on the select scope's implicit close.",
  },
  {
    id: "unclosed-heading",
    html: "<h1>title<h2>subtitle",
    why: "A new heading implicitly closes the open one (heading-element scope).",
  },
  {
    id: "unclosed-button",
    html: "<button>a<button>b</button>",
    why: "A second <button> start tag closes the first (button scope).",
  },
  {
    id: "nested-form-ignored",
    html: "<form id=outer><input><form id=inner><input></form>",
    why: "The inner <form> is ignored while a form-element pointer is set — the tree holds one form.",
  },
  {
    id: "orphan-li",
    html: "<li>orphan<li>orphan2",
    why: "An <li> outside any list still builds list-item elements directly under body.",
  },

  // --- Stray and mid-document end tags --------------------------------------
  {
    id: "stray-end-tags",
    html: "<div>a</p></li></td></table></span>b</div>",
    why: "End tags with no matching open element are parse errors and must be ignored, not drop content.",
  },
  {
    id: "body-end-mid-content",
    html: "<p>a</body><p>b</html><p>c",
    why: "</body> and </html> mid-content switch to after-body insertion modes while body content still follows.",
  },
  {
    id: "html-end-then-content",
    html: "<html><body><p>a</p></html><div>b</div>",
    why: "Content after </html> is folded back into body by the after-after-body insertion mode.",
  },
  {
    id: "end-tag-with-attrs",
    html: "<p>a</p class=x>b",
    why: "Attributes on an end tag are a parse error; the close still applies, attributes are dropped.",
  },
  {
    id: "eof-in-tag",
    html: "<p>done<div",
    why: "EOF inside a tag name: the partial tag never becomes an element.",
  },
  {
    id: "eof-in-end-tag",
    html: "<p>done</p",
    why: "EOF inside an end tag: the partial close is dropped at end of input.",
  },
  {
    id: "missing-body-html-end",
    html: "<!DOCTYPE html><html><body><article><p>text",
    why: "EOF without </body>/</html> must still close the tree cleanly.",
  },
  {
    id: "missing-everything",
    html: "plain text, no tags at all",
    why: "A document with zero markup still produces html/head/body.",
  },

  // --- Doctype and bogus markup ---------------------------------------------
  {
    id: "quirks-no-doctype",
    html: "<p>a<table><tr><td>b</td></tr></table><p>c",
    why: "No doctype means quirks mode: <p> around <table> exercises quirks-only paragraph/table interplay.",
  },
  {
    id: "limited-quirks-doctype",
    html: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><p>a',
    why: "A legacy public doctype lands the document in limited-quirks mode.",
  },
  {
    id: "doctype-mid-body",
    html: "<p>a<!DOCTYPE html><p>b",
    why: "A <!DOCTYPE> token after the first element is a parse error and must be ignored.",
  },
  {
    id: "bogus-markup-trio",
    html: "<p>a</><!x><?x>b</p>",
    why: "'</>' is an empty end tag (ignored); '<!x>' and '<?x>' are bogus comments that swallow until '>'.",
  },
  {
    id: "php-processing-instruction",
    html: "<p>a<?php echo 1 ?>b</p>",
    why: "<?php … ?> is a bogus comment in HTML, never an instruction.",
  },
  {
    id: "unterminated-comment",
    html: "<p>a<!-- never closed",
    why: "An unterminated comment swallows the rest of the document as comment data.",
  },
  {
    id: "comment-abrupt-close",
    html: "<p>a<!-->b</p>",
    why: "<!--> is an abrupt empty comment — 'b' must still be text, not comment.",
  },
  {
    id: "comment-nested-open",
    html: "<p>a<!-- x <!-- y -->b</p>",
    why: "Nested <!-- inside a comment is just text; the first --> ends it.",
  },
  {
    id: "cdata-in-html",
    html: "<p>a<![CDATA[markup <b>here</b>]]>b</p>",
    why: "CDATA outside foreign content is a bogus comment, not character data.",
  },
  {
    id: "cdata-in-svg",
    html: "<svg><![CDATA[not <markup>]]></svg><p>x",
    why: "CDATA is legal inside SVG: its contents are character data, not elements.",
  },

  // --- Foster parenting ------------------------------------------------------
  {
    id: "foster-parented-text",
    html: "<table>x<td>cell</table>after",
    why: "Text and a stray <td> inside <table> are foster-parented out before the table element.",
  },
  {
    id: "foster-in-dl",
    html: "<dl><dd>c <table>x<td>cell",
    why: "Foster parenting inside <dd>: 'x' and the stray <td> leave the table while 'c ' stays put.",
  },
  {
    id: "foster-element",
    html: "<table><div>inside</div><tr><td>cell</td></tr></table>",
    why: "A <div> child of <table> is foster-parented above the table, reordering the tree.",
  },
  {
    id: "select-in-table",
    html: "<table><select><option>x</select><tr><td>c</td></tr></table>",
    why: "<select> inside <table> interacts with both foster parenting and select scope.",
  },

  // --- Adoption agency / formatting misnesting -------------------------------
  {
    id: "adoption-b-p",
    html: "<b><p>x</b>y</p>",
    why: "</b> across a <p> boundary runs the adoption agency algorithm — splits and clones the formatting element.",
  },
  {
    id: "adoption-a-a",
    html: "<a href=one>x<a href=two>y</a>z",
    why: "A second <a> implicitly closes the first — one link run becomes two siblings.",
  },
  {
    id: "adoption-nobr",
    html: "<nobr>a<nobr>b<nobr>c",
    why: "Nested <nobr> triggers adoption agency repeatedly for the same formatting tag.",
  },
  {
    id: "adoption-cross-cell",
    html: "<b><table><tr><td>x</b>y</td></tr></table>",
    why: "Formatting opened outside a table but closed inside a cell stresses the 'in table text' modes.",
  },

  // --- Foreign content -------------------------------------------------------
  {
    id: "svg-block-breakout",
    html: "<svg><desc>d</desc><p>html block</p><rect/></svg><p>after",
    why: "A <p> inside <svg> exits foreign content back to HTML mode — the <rect> that follows is HTML, not SVG.",
  },
  {
    id: "foreignobject-block",
    html: "<svg><foreignObject><section><p>x</p></section></foreignObject><circle/></svg>",
    why: "foreignObject legitimately nests HTML block content inside SVG — namespaces must stay straight.",
  },
  {
    id: "math-annotation-html",
    html: '<math><annotation-xml encoding="text/html"><div>d</div></annotation-xml><mi>x</mi></math>',
    why: "annotation-xml with encoding=text/html re-enters HTML parsing inside MathML.",
  },
  {
    id: "math-mglyph-style",
    html: "<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>",
    why: "The classic mXSS nesting: namespace switching plus a style boundary hides markup from simple filters.",
  },
  {
    id: "svg-unclosed",
    html: "<svg><circle/><p>after",
    why: "An unclosed <svg> makes the trailing <p> SVG text content instead of an HTML paragraph.",
  },

  // --- Raw text and templating -------------------------------------------------
  {
    id: "template-at-eof",
    html: "<div><template><tr><td>x",
    why: "An unclosed <template> at EOF: template contents live in a separate fragment with no sibling chain.",
  },
  {
    id: "template-in-table",
    html: "<table><template><tr><td>x</td></tr></template></table>",
    why: "A template wrapping table internals — the table scope must see through the template boundary.",
  },
  {
    id: "noscript-unbalanced",
    html: "<noscript><p>x",
    why: "Unclosed <noscript> at EOF: scripting-off parses children as markup, scripting-on swallows raw text.",
  },
  {
    id: "noscript-nested",
    html: "<noscript><noscript><p>x</noscript></noscript><p>y",
    why: "Nested <noscript> reads differently under scripting on vs off — two parses of the same bytes.",
  },
  {
    id: "head-elements-in-body",
    html: "<body><p>a<title>t</title><style>.x{}</style><meta name=m><link href=l><p>b",
    why: "Head-only elements appearing in body context must not reopen head or corrupt surrounding paragraphs.",
  },
  {
    id: "plaintext-swallows-rest",
    html: "<p>a<plaintext><script>alert(1)</script></plaintext><p>b",
    why: "<plaintext> turns the whole rest of the file into raw text — its own end tag is inert.",
  },
  {
    id: "xmp-rawtext",
    html: "<xmp><b>not bold</b></xmp><p>after",
    why: "<xmp> raw text keeps '<b>' as literal text until </xmp>.",
  },
  {
    id: "xmp-unterminated",
    html: "<xmp><img src=x onerror=alert(1)>",
    why: "EOF inside <xmp>: the payload stays inert text — a parser must not resurrect it as an element.",
  },
  {
    id: "textarea-rawtext",
    html: "<textarea>a<b>c</textarea><p>after",
    why: "<textarea> is RCDATA: markup inside is character data, not elements.",
  },
  {
    id: "textarea-escape-attempt",
    html: "<textarea></textarea><script>alert(1)</script>",
    why: "Text that merely looks like '</textarea>' inside RCDATA ends it early — breakout-shaped input.",
  },
  {
    id: "title-rcdata",
    html: "<title>a<b>c</title><p>x",
    why: "<title> is RCDATA: '<b>' is text, only the matching </title> ends it.",
  },
  {
    id: "iframe-srcdoc-rawtext",
    html: '<iframe srcdoc="<p>x</p>"></iframe><p>after',
    why: "srcdoc nests a second document inside an attribute — quoting must survive both parses.",
  },

  // --- Encodings, whitespace, entities ---------------------------------------
  {
    id: "bom-prefix",
    html: "\uFEFF<p>a</p>",
    why: "A leading U+FEFF BOM is stripped by the encoding layer — it must not surface as a text node.",
  },
  {
    id: "mixed-newlines",
    html: "<p>a\r\nb\rc\nd</p>\r\n<table>\r<tr>\n<td>x</td>",
    why: "CRLF, CR and LF mixed: the tokenizer normalizes all three to LF before the tree builder sees them.",
  },
  {
    id: "nul-in-text",
    html: "<p>a\0b</p>",
    why: "NUL in body text is replaced by U+FFFD — never kept, never fatal.",
  },
  {
    id: "nul-in-tag",
    html: "<p\0a=x>t</p\0>",
    why: "NUL inside tag names produces U+FFFD in the name — a different handling path than NUL in text.",
  },
  {
    id: "entities-named",
    html: "<p>&amp;&lt;&gt;&quot;&copy;&notin;&notit;&fake;&amp</p>",
    why: "Named entities incl. the ambiguous '&notit;' (&not; + 'it') and names that must stay literal.",
  },
  {
    id: "entities-numeric",
    html: "<p>&#65;&#x41;&#0;&#xD800;&#x110000;&#x80;</p>",
    why: "Numeric entity edges: NUL→FFFD, lone surrogate→FFFD, out-of-range→FFFD, C1→windows-1252 remap.",
  },
  {
    id: "entities-in-attr",
    html: '<a href="?a=1&amp;b=2&#65;&fake;">x</a>',
    why: "Entities in attribute values decode once — no double-decode, no re-escape divergence.",
  },
  {
    id: "invalid-utf8",
    bytes: new Uint8Array([
      0x3c, 0x70, 0x3e, 0x61, 0xff, 0xfe, 0x62, 0x80, 0x63, 0x3c, 0x2f, 0x70, 0x3e,
    ]),
    why: "Invalid UTF-8 bytes (0xFF, stray 0x80) decode to U+FFFD under the mandated UTF-8 error handling.",
  },
  {
    id: "utf8-overlong",
    bytes: new Uint8Array([0x3c, 0x70, 0x3e, 0x61, 0xc0, 0xaf, 0x62, 0x3c, 0x2f, 0x70, 0x3e]),
    why: "An overlong encoding (0xC0 0xAF for '/') must decode to U+FFFD pairs, never smuggle a real slash.",
  },
  {
    id: "truncated-utf8",
    bytes: new Uint8Array([0x3c, 0x70, 0x3e, 0x61, 0xe4, 0xb8, 0x3c, 0x2f, 0x70, 0x3e]),
    why: "A three-byte sequence truncated by the next tag start decodes to one U+FFFD, not a smuggled '<'.",
  },
  {
    id: "deep-nesting-5000",
    html: nestedTagHtml("div", 5000),
    why: "5000 unclosed <div>s: recursive walkers hit stack limits long before iterative ones do.",
  },
  {
    id: "deep-nesting-balanced-5000",
    html: balancedNestedHtml("span", 5000, "x"),
    why: "5000 *balanced* nested elements — legal input that still overflows naive recursive serializers.",
  },
  {
    id: "duplicate-attrs",
    html: "<p id=a id=b class=x class=y>t</p>",
    why: "Duplicate attributes: the first wins, later ones are parse errors that must be dropped.",
  },
  {
    id: "image-is-img",
    html: "<image src=x onerror=alert(1)>",
    why: "<image> is tokenized as <img> (a historic parse error turned spec) — filters keying on 'image' miss it.",
  },
  {
    id: "unquoted-attr-eof",
    html: "<p title=unclosed>x",
    why: "An unquoted attribute ending at EOF must still yield a complete element.",
  },
];

/** Extracts the document text of an entry: `html` verbatim, `bytes` decoded under the mandated UTF-8 error handling. */
export const malformedHtmlText = (entry: MalformedHtmlEntry): string =>
  "html" in entry ? entry.html : new TextDecoder("utf-8").decode(entry.bytes);
