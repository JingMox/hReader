// Shared adversarial corpus: URL edge cases for resolvers, fetchers, link checkers
// and anything that echoes a URL into markup, a shell or a log.

/** One hostile or edge-case URL. `why` states the stress the string carries. */
export interface UrlCase {
  /** Stable id so a failure can name the case across reports and tickets. */
  readonly id: string;
  readonly url: string;
  readonly why: string;
}

/** Pads `prefix` with 'x' to exactly `totalLength` chars — for the 2048/2049 boundary cases. */
export const paddedUrl = (prefix: string, totalLength: number): string =>
  totalLength <= prefix.length
    ? prefix.slice(0, totalLength)
    : prefix + "x".repeat(totalLength - prefix.length);

export const URL_CASES: readonly UrlCase[] = [
  // --- Schemes ---------------------------------------------------------------
  { id: "https-basic", url: "https://example.com/a?b=c#d", why: "canonical https" },
  { id: "http-basic", url: "http://example.com/", why: "plain http" },
  {
    id: "protocol-relative",
    url: "//evil.example/x",
    why: "protocol-relative — inherits whatever scheme the host page uses",
  },
  {
    id: "scheme-uppercase",
    url: "HTTPS://EXAMPLE.COM/",
    why: "scheme and host case normalization",
  },
  {
    id: "feed-wrapper",
    url: "feed:https://example.com/rss",
    why: "feed: wraps another URL — handlers must decide which layer to trust",
  },
  {
    id: "file-scheme",
    url: "file:///etc/passwd",
    why: "file: reaches the local filesystem",
  },
  { id: "about-blank", url: "about:blank", why: "opaque about: URL" },
  {
    id: "mailto",
    url: "mailto:a@b.c?subject=x",
    why: "mailto with a query part",
  },
  {
    id: "custom-scheme",
    url: "hreader://open/x",
    why: "an app scheme — launcher/deep-link surface",
  },
  { id: "opaque-scheme", url: "a.b:c", why: "a non-special scheme with an opaque path" },
  {
    id: "javascript-url",
    url: "javascript:alert(1)",
    why: "javascript: as a navigational URL — the reason allowlists exist",
  },

  // --- Credentials ------------------------------------------------------------
  {
    id: "creds-basic",
    url: "https://user:pass@example.com/",
    why: "embedded credentials — phishing shape and a log-leak vector",
  },
  {
    id: "creds-empty",
    url: "https://:@example.com/",
    why: "empty userinfo still counts as credentials",
  },
  {
    id: "creds-encoded",
    url: "https://user%40:p%3Ass@example.com/",
    why: "percent-encoded credentials — '@' and ':' hidden in userinfo",
  },
  {
    id: "two-ats",
    url: "https://a@b@c/",
    why: "two @ signs — the last one wins; the first hides in userinfo",
  },
  {
    id: "at-in-path",
    url: "https://example.com/@user",
    why: "@ in the path is not userinfo — misreading it fabricates a credential",
  },

  // --- Internationalized names -------------------------------------------------
  {
    id: "idn-unicode",
    url: "https://例え.jp/パス",
    why: "IDN host plus a unicode path — must normalize identically everywhere",
  },
  {
    id: "idn-punycode",
    url: "https://xn--r8jz45g.jp/",
    why: "the punycode form of 例え.jp — same host, different bytes",
  },
  {
    id: "idn-homograph",
    url: "https://\u0435xample.com/",
    why: "Cyrillic U+0435 homograph of example.com — looks right, resolves elsewhere",
  },

  // --- Host oddities ------------------------------------------------------------
  {
    id: "ipv6",
    url: "https://[::1]:8080/x",
    why: "IPv6 literal with a port",
  },
  {
    id: "ipv4-dword",
    url: "https://2130706433/",
    why: "dword-form IPv4 is 127.0.0.1 — SSRF filters that only match dotted form miss it",
  },
  {
    id: "ipv4-hex",
    url: "https://0x7f.0x0.0x0.0x1/",
    why: "hex octets are also 127.0.0.1",
  },
  {
    id: "ipv4-octal",
    url: "https://0177.0.0.01/",
    why: "octal octets are also 127.0.0.1",
  },
  {
    id: "ipv4-shorthand",
    url: "https://127.1/",
    why: "two-part IPv4 shorthand is 127.0.0.1",
  },
  {
    id: "port-max",
    url: "https://example.com:65535/",
    why: "the maximum legal port",
  },
  {
    id: "port-overflow",
    url: "https://example.com:99999/",
    why: "port above 65535 — must fail, never silently wrap",
  },
  {
    id: "double-dot-host",
    url: "https://example..com/",
    why: "an empty host label — DNS-invalid but parser-legal",
  },

  // --- Whitespace, controls, dot-segments ---------------------------------------
  {
    id: "ws-leading-trailing",
    url: "  https://example.com/ ",
    why: "leading/trailing C0 and space are stripped by the URL parser",
  },
  {
    id: "ws-tab-newline-inside",
    url: "https://exa\tmple.com/\nx",
    why: "tab and LF inside the URL are removed during parsing",
  },
  {
    id: "ctrl-nul",
    url: "https://example.com/a\0b",
    why: "NUL inside the path",
  },
  {
    id: "ctrl-del-bel",
    url: "https://example.com/\u007F\u0007",
    why: "DEL and BEL controls inside the path",
  },
  {
    id: "dot-segments",
    url: "https://example.com/a/../b/./c",
    why: "dot-segments normalize away — the resolved URL differs from the typed one",
  },
  {
    id: "backslashes",
    url: "https:\\example.com\\x",
    why: "backslashes count as slashes for special schemes — a different URL than typed",
  },
  { id: "empty", url: "", why: "the empty input" },
  { id: "fragment-only", url: "#frag", why: "a fragment-only reference" },
  { id: "query-only", url: "?q=1", why: "a query-only reference" },
  { id: "just-scheme", url: "https:", why: "a scheme with nothing after it" },

  // --- Length boundary -----------------------------------------------------------
  {
    id: "len-2048",
    url: paddedUrl("https://example.com/", 2048),
    why: "exactly 2048 chars — the classic URL length boundary",
  },
  {
    id: "len-2049",
    url: paddedUrl("https://example.com/", 2049),
    why: "one char past the boundary",
  },
];
