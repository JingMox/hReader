// This layer: `annotations/body-text.ts` — the body text domain used by the
// selector-miss fallback in relocate.ts. The domain is every text node under
// `<body>` in document order, skipping the raw-text/non-rendering subtrees
// (`script`, `style`, `template`, `noscript`): an anchor must never re-land on
// bytes the reader cannot see.

import { describe, expect, it } from "vitest";

import { bodyTextOf } from "../../src/annotations/body-text";
import { docRelocatorOf } from "../../src/annotations/relocate";
import type { SidecarAnnotation } from "../../src/annotations/sidecar-model";
import { parseHtml } from "../../src/html/parse";

const note = (patch: Partial<SidecarAnnotation> = {}): SidecarAnnotation => ({
  id: "an-00000000",
  anchor: { exact: "needle", prefix: "", suffix: "", start: 0 },
  note: "",
  status: "pending",
  createdAt: "2024-01-01T00:00:00.000Z",
  author: "user",
  replies: [],
  ...patch,
});

describe("bodyTextOf · domain", () => {
  it("should collect every text node under body in document order", () => {
    const parsed = parseHtml(
      "<html><body><div><p>first</p><p>second</p></div><ul><li>third</li></ul>tail</body></html>",
    );

    expect(bodyTextOf(parsed)).toBe("firstsecondthirdtail");
  });

  it("should skip script, style, template and noscript subtrees at any depth", () => {
    const parsed = parseHtml(
      [
        "<html><body>",
        "<div><script>script-secret</script>",
        "<section><div><style>style-secret</style></div></section>",
        "<p>kept</p>",
        "<template><p>template-secret</p></template>",
        "<noscript><p>noscript-secret</p></noscript>",
        "</div>after",
        "</body></html>",
      ].join(""),
    );

    expect(bodyTextOf(parsed)).toBe("keptafter");
  });

  it("should skip the #hr-meta script", () => {
    const parsed = parseHtml(
      '<html><body><p>prose</p><script id="hr-meta">{"annotations":[]}</script></body></html>',
    );

    expect(bodyTextOf(parsed)).toBe("prose");
  });

  it("should not include text that lives in head", () => {
    const parsed = parseHtml(
      "<html><head><title>head-title</title></head><body><p>body-text</p></body></html>",
    );

    expect(bodyTextOf(parsed)).toBe("body-text");
  });

  it("should preserve whitespace verbatim", () => {
    const parsed = parseHtml(
      "<html><body><p>a  b\n\tc</p><pre>  spaced\n out  </pre></body></html>",
    );

    expect(bodyTextOf(parsed)).toBe("a  b\n\tc  spaced\n out  ");
  });

  it("should decode entities the way parse5 reports them", () => {
    const parsed = parseHtml(
      "<html><body><p>fish &amp; chips &lt;tag&gt; &nbsp;end</p></body></html>",
    );

    expect(bodyTextOf(parsed)).toBe("fish & chips <tag> \u00a0end");
  });

  it("should return the empty string for a body-less document", () => {
    expect(bodyTextOf(parseHtml(""))).toBe("");
  });

  it("should return the empty string when body only holds skipped subtrees", () => {
    const parsed = parseHtml(
      "<html><body><script>only-script</script><style>only-style</style></body></html>",
    );

    expect(bodyTextOf(parsed)).toBe("");
  });
});

describe("docRelocatorOf · body fallback text domain", () => {
  it("should not relocate an exact that only appears inside <script>", () => {
    const relocate = docRelocatorOf(
      '<html><body><p>visible text</p><script>marker = "needle"</script></body></html>',
    );
    const result = relocate(note({ selector: "body > table:nth-of-type(1)" }));

    expect(result).toEqual({ ok: false, reason: "anchor_lost", via: "body" });
  });

  it("should still relocate an exact that appears in visible body text", () => {
    const relocate = docRelocatorOf(
      "<html><body><p>before needle after</p><script>needle</script></body></html>",
    );
    const result = relocate(note({ selector: "body > table:nth-of-type(1)" }));

    expect(result).toEqual({ ok: true, start: 7, end: 13, via: "body" });
  });

  it("should see text after a nested noscript's early end (the browser's scripting-on view)", () => {
    // With scripting enabled <noscript> is raw text that ends at the FIRST
    // `</noscript>`: "a<noscript>b" is the raw payload, "needle" is live body
    // text and the stray closer drops. The annotation domain must parse like
    // the browser — every browser surface this domain faces runs scripts.
    const relocate = docRelocatorOf(
      "<html><body><p>visible</p><noscript>a<noscript>b</noscript>needle</noscript></body></html>",
    );
    const result = relocate(note({ selector: "body > table:nth-of-type(1)" }));

    expect(result).toEqual({ ok: true, start: 7, end: 13, via: "body" });
  });

  it("should still relocate around a plain (non-nested) noscript", () => {
    // Non-regression: the scripting flip must not move offsets for documents
    // that carry a simple noscript — annotations made before the change stay
    // anchored.
    const relocate = docRelocatorOf(
      "<html><body><p>a needle</p><noscript><p>hidden</p></noscript>tail</body></html>",
    );
    const result = relocate(note({ selector: "body > table:nth-of-type(1)" }));

    expect(result).toEqual({ ok: true, start: 2, end: 8, via: "body" });
  });
});
