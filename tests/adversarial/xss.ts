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

  // --- Scheme payloads for href/src slots ------------------------------------
  {
    id: "url-javascript",
    payload: "javascript:alert(1)",
    why: "the bare javascript: scheme",
  },
  {
    id: "url-javascript-case",
    payload: "JaVaScRiPt:alert(1)",
    why: "scheme matching is case-insensitive",
  },
  {
    id: "url-javascript-leading-ws",
    payload: "  javascript:alert(1)",
    why: "leading whitespace is stripped before the scheme check",
  },
  {
    id: "url-javascript-tab",
    payload: "java\tscript:alert(1)",
    why: "ASCII tab inside the scheme — the URL parser removes it",
  },
  {
    id: "url-javascript-entity",
    payload: "&#106;avascript:alert(1)",
    why: "numeric entity for 'j' — decoded before the scheme check",
  },
  {
    id: "url-javascript-named-entity",
    payload: "java&Tab;script:alert(1)",
    why: "named entity &Tab; inside the scheme",
  },
  {
    id: "url-javascript-colon-entity",
    payload: "javascript&#58;alert(1)",
    why: "entity-encoded colon",
  },
  {
    id: "url-vbscript",
    payload: "vbscript:msgbox(1)",
    why: "legacy IE scheme — still blocked by every scheme allowlist",
  },
  {
    id: "url-vbscript-case-ws",
    payload: " VBSCRIPT:x",
    why: "case + leading-space variant of vbscript:",
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
  },
  {
    id: "url-data-entity",
    payload: "data&colon;text/html,x",
    why: "named-entity colon inside the scheme",
  },

  // --- Template / expression injection ----------------------------------------
  {
    id: "template-constructor",
    payload: "{{constructor.constructor('alert(1)')()}}",
    why: "the classic sandbox-escape idiom — any mustache evaluator must not compile it",
  },
  {
    id: "template-canary",
    payload: "{{7*7}}",
    why: "the canary expression: rendering '49' proves the template was evaluated",
  },
  {
    id: "template-dollar",
    payload: "${alert(1)}",
    why: "template-literal interpolation shape",
  },

  // --- Unicode and control-character payloads ---------------------------------
  {
    id: "unicode-rtl-override",
    payload: "safe_\u202Etxt.exe",
    why: "RLO flips display order — 'exe' reads as a text filename in rendered output",
  },
  {
    id: "unicode-lro",
    payload: "\u202Dleft-to-right override",
    why: "LRO embedding — direction confusion inside rendered text",
  },
  {
    id: "unicode-bidi-isolate",
    payload: "a\u2066bidi\u2069",
    why: "LRI/PDI isolates — the subtler bidi controls filters often forget",
  },
  {
    id: "zwsp-in-scheme",
    payload: "java\u200Bscript:alert(1)",
    why: "zero-width space splits 'javascript' invisibly — literal-match filters miss it",
  },
  {
    id: "zwnj-zwj",
    payload: "a\u200C\u200Db",
    why: "ZWNJ/ZWJ joiners are invisible in rendered text",
  },
  {
    id: "bom-mid-string",
    payload: "a\uFEFFb",
    why: "a mid-string U+FEFF is a zero-width no-break space, not a BOM",
  },
  {
    id: "tag-chars",
    payload: "\u{E0061}\u{E0062}",
    why: "tag characters (U+E0061+) are invisible watermarking",
  },
  {
    id: "ctrl-bel",
    payload: "a\u0007b",
    why: "BEL rings terminals and pollutes logs when echoed",
  },
  {
    id: "ctrl-esc-ansi",
    payload: "a\u001B[31mRED",
    why: "ANSI escape — colors or rewrites terminal output when a name is printed raw",
  },
  {
    id: "ctrl-del",
    payload: "a\u007Fb",
    why: "DEL — a control char many filters skip",
  },
  {
    id: "ctrl-vt-ff",
    payload: "a\u000B\u000Cb",
    why: "VT/FF look like line breaks to renderers but not to some filters",
  },

  // --- Length stress -----------------------------------------------------------
  {
    id: "long-100k",
    payload: "A".repeat(100_000),
    why: "a 100k-char string — the unbounded-length DoS surface",
  },
  {
    id: "long-unclosed-tags",
    payload: "<i>x".repeat(20_000),
    why: "20k unclosed tags — length and nesting stress combined",
  },
];
