// Shared adversarial corpus: XSS and injection payloads.
//
// The payloads are inputs, not judgments — a sanitizer test feeds them in, a renderer
// test checks they render as text, a URL checker matches them against an allowlist.

/** One injection payload. `why` states the attack the string carries. */
export interface XssCase {
  /** Stable id so a failure can name the case across reports and tickets. */
  readonly id: string;
  readonly payload: string;
  readonly why: string;
  /**
   * Present when the payload parses to no dangerous structure (text and/or benign
   * elements only); the string is the reason that is acceptable — for example a
   * bare URL string whose danger lives in an href slot, not in markup. When the
   * field is absent, an element-checker must reject whatever the payload parses to.
   */
  readonly inertReason?: string;
}

export const XSS_PAYLOADS: readonly XssCase[] = [
  // --- Element / attribute markup -------------------------------------------
  {
    id: "img-onerror",
    payload: "<img src=x onerror=alert(1)>",
    why: "the canonical attribute-handler injection — fires without any user gesture",
  },
  {
    id: "svg-onload",
    payload: "<svg onload=alert(1)>",
    why: "<svg> is markup that executes handlers, not just an image",
  },
  {
    id: "svg-animate-href",
    payload: '<svg><animate attributeName=href values="javascript:alert(1)" /></svg>',
    why: "SVG animation can mutate a link's href into javascript: after parse",
  },
  {
    id: "script-plain",
    payload: "<script>alert(1)</script>",
    why: "the baseline script element",
  },
  {
    id: "textarea-breakout",
    payload: "</textarea><script>alert(1)</script>",
    why: "closes a host <textarea> early — text meant to stay inert becomes live markup",
  },
  {
    id: "mark-breakout",
    payload: "</mark><script>alert(1)</script>",
    why: "closes <mark> early — the same breakout through a harmless-looking wrapper",
  },
  {
    id: "title-breakout",
    payload: "</title><script>alert(1)</script>",
    why: "closes <title> RCDATA early — head-text becomes body markup",
  },
  {
    id: "style-breakout",
    payload: "</style><script>alert(1)</script>",
    why: "closes <style> raw text early — CSS context becomes markup",
  },
  {
    id: "iframe-srcdoc",
    payload: '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    why: "srcdoc nests a whole hostile document inside one attribute",
  },
  {
    id: "details-ontoggle",
    payload: "<details open ontoggle=alert(1)>x</details>",
    why: "auto-firing handler that needs no click — 'open' triggers ontoggle at parse",
  },
  {
    id: "video-source-onerror",
    payload: "<video><source onerror=alert(1)></video>",
    why: "media fallback handlers fire when the source fails to load",
  },
  {
    id: "math-annotation-xss",
    payload:
      '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>',
    why: "annotation-xml text/html re-enters HTML parsing inside MathML — a namespace-confusion vector",
  },
  {
    id: "a-href-javascript",
    payload: '<a href="javascript:alert(1)">x</a>',
    why: "the script scheme reaches the DOM through a plain href",
  },
  {
    id: "a-href-data",
    payload: '<a href="data:text/html,<b>x</b>">x</a>',
    why: "a data: URL in href navigates into attacker markup",
  },
  {
    id: "button-formaction",
    payload: '<button formaction="javascript:alert(1)">x</button>',
    why: "formaction overrides the form's action — a script scheme rides on a benign tag",
  },
  {
    id: "div-srcdoc",
    payload: '<div srcdoc="<script>alert(1)</script>">x</div>',
    why: "srcdoc on any element means nested hostile markup shipped inside an attribute",
  },
  {
    id: "a-xlink-href",
    payload: '<a xlink:href="javascript:alert(1)">x</a>',
    why: "namespaced href — the scheme check must look past the xlink: prefix",
  },

  // --- Scheme payloads for href/src slots ------------------------------------
  // These are bare strings, not markup: parsed as a fragment they produce a text
  // node, so `inertReason` marks them. Their danger lives inside href/src-style
  // attribute slots, where the same decoding and scheme rules apply.
  {
    id: "url-javascript",
    payload: "javascript:alert(1)",
    why: "the bare javascript: scheme",
    inertReason:
      "a bare URL string parses to a text node — the attribute scheme check carries the danger",
  },
  {
    id: "url-javascript-case",
    payload: "JaVaScRiPt:alert(1)",
    why: "scheme matching is case-insensitive",
    inertReason:
      "a bare URL string parses to a text node — the attribute scheme check carries the danger",
  },
  {
    id: "url-javascript-leading-ws",
    payload: "  javascript:alert(1)",
    why: "leading whitespace is stripped before the scheme check",
    inertReason:
      "a bare URL string parses to a text node — the attribute scheme check carries the danger",
  },
  {
    id: "url-javascript-tab",
    payload: "java\tscript:alert(1)",
    why: "ASCII tab inside the scheme — the URL parser removes it",
    inertReason:
      "a bare URL string parses to a text node — the attribute scheme check carries the danger",
  },
  {
    id: "url-javascript-entity",
    payload: "&#106;avascript:alert(1)",
    why: "numeric entity for 'j' — decoded before the scheme check",
    inertReason:
      "the parser decodes the entity into a bare URL text node — attribute values get the same decoding",
  },
  {
    id: "url-javascript-named-entity",
    payload: "java&Tab;script:alert(1)",
    why: "named entity &Tab; inside the scheme",
    inertReason:
      "the parser decodes the entity into a bare URL text node — attribute values get the same decoding",
  },
  {
    id: "url-javascript-colon-entity",
    payload: "javascript&#58;alert(1)",
    why: "entity-encoded colon",
    inertReason:
      "the parser decodes the entity into a bare URL text node — attribute values get the same decoding",
  },
  {
    id: "url-vbscript",
    payload: "vbscript:msgbox(1)",
    why: "legacy IE scheme — still blocked by every scheme allowlist",
    inertReason:
      "a bare URL string parses to a text node — the attribute scheme check carries the danger",
  },
  {
    id: "url-vbscript-case-ws",
    payload: " VBSCRIPT:x",
    why: "case + leading-space variant of vbscript:",
    inertReason:
      "a bare URL string parses to a text node — the attribute scheme check carries the danger",
  },
  {
    id: "url-data-html",
    payload: "data:text/html,<script>alert(1)</script>",
    why: "a data: URL carrying a full HTML document",
  },
  {
    id: "url-data-svg-b64",
    payload: "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
    why: "base64 SVG that decodes to <svg onload=alert(1)>",
    inertReason:
      "a bare URL string parses to a text node — the attribute scheme check carries the danger",
  },
  {
    id: "url-data-entity",
    payload: "data&colon;text/html,x",
    why: "named-entity colon inside the scheme",
    inertReason:
      "the parser decodes the entity into a bare URL text node — attribute values get the same decoding",
  },

  // --- Template / expression injection ----------------------------------------
  // Expression idioms stay text under an HTML parse — they attack a mustache or
  // template-literal evaluator, not the markup layer, so `inertReason` marks them.
  {
    id: "template-constructor",
    payload: "{{constructor.constructor('alert(1)')()}}",
    why: "the classic sandbox-escape idiom — any mustache evaluator must not compile it",
    inertReason:
      "a template-expression idiom parses to a text node — its danger is an evaluator compiling it",
  },
  {
    id: "template-canary",
    payload: "{{7*7}}",
    why: "the canary expression: rendering '49' proves the template was evaluated",
    inertReason:
      "a template-expression idiom parses to a text node — its danger is an evaluator compiling it",
  },
  {
    id: "template-dollar",
    payload: "${alert(1)}",
    why: "template-literal interpolation shape",
    inertReason:
      "a template-expression idiom parses to a text node — its danger is an evaluator compiling it",
  },

  // --- Unicode and control-character payloads ---------------------------------
  // Display-order, invisible-character and control attacks produce text nodes
  // only — no markup — so they carry `inertReason`; their harm shows up when the
  // text is rendered, logged or passed to a shell.
  {
    id: "unicode-rtl-override",
    payload: "safe_\u202Etxt.exe",
    why: "RLO flips display order — 'exe' reads as a text filename in rendered output",
    inertReason:
      "a display-order attack produces a text node only — it harms when rendered, not when parsed",
  },
  {
    id: "unicode-lro",
    payload: "\u202Dleft-to-right override",
    why: "LRO embedding — direction confusion inside rendered text",
    inertReason:
      "a display-order attack produces a text node only — it harms when rendered, not when parsed",
  },
  {
    id: "unicode-bidi-isolate",
    payload: "a\u2066bidi\u2069",
    why: "LRI/PDI isolates — the subtler bidi controls filters often forget",
    inertReason:
      "a display-order attack produces a text node only — it harms when rendered, not when parsed",
  },
  {
    id: "zwsp-in-scheme",
    payload: "java\u200Bscript:alert(1)",
    why: "zero-width space splits 'javascript' invisibly — literal-match filters miss it",
    inertReason:
      "a bare URL string parses to a text node — the attribute scheme check carries the danger",
  },
  {
    id: "zwnj-zwj",
    payload: "a\u200C\u200Db",
    why: "ZWNJ/ZWJ joiners are invisible in rendered text",
    inertReason: "invisible text characters produce a text node only",
  },
  {
    id: "bom-mid-string",
    payload: "a\uFEFFb",
    why: "a mid-string U+FEFF is a zero-width no-break space, not a BOM",
    inertReason: "invisible text characters produce a text node only",
  },
  {
    id: "tag-chars",
    payload: "\u{E0061}\u{E0062}",
    why: "tag characters (U+E0061+) are invisible watermarking",
    inertReason: "invisible text characters produce a text node only",
  },
  {
    id: "ctrl-bel",
    payload: "a\u0007b",
    why: "BEL rings terminals and pollutes logs when echoed",
    inertReason: "control characters attack terminals and logs — a text node only",
  },
  {
    id: "ctrl-esc-ansi",
    payload: "a\u001B[31mRED",
    why: "ANSI escape — colors or rewrites terminal output when a name is printed raw",
    inertReason: "control characters attack terminals and logs — a text node only",
  },
  {
    id: "ctrl-del",
    payload: "a\u007Fb",
    why: "DEL — a control char many filters skip",
    inertReason: "control characters attack terminals and logs — a text node only",
  },
  {
    id: "ctrl-vt-ff",
    payload: "a\u000B\u000Cb",
    why: "VT/FF look like line breaks to renderers but not to some filters",
    inertReason: "control characters attack terminals and logs — a text node only",
  },

  // --- Length stress -----------------------------------------------------------
  {
    id: "long-100k",
    payload: "A".repeat(100_000),
    why: "a 100k-char string — the unbounded-length DoS surface",
    inertReason: "pure length stress — a text node only",
  },
  {
    id: "long-unclosed-tags",
    payload: "<i>x".repeat(20_000),
    why: "20k unclosed tags — length and nesting stress combined",
    inertReason:
      "produces only benign <i> elements — the stress target is the parser budget, not the element filter",
  },
];
