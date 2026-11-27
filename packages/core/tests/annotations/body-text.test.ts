// This layer: `annotations/body-text.ts` — the body text domain used by the
// selector-miss fallback in relocate.ts. The domain is every text node under
// `<body>` in document order, skipping the raw-text/non-rendering subtrees
// (`script`, `style`, `template`, `noscript`): an anchor must never re-land on
// bytes the reader cannot see.

import { describe, expect, it } from "vitest";

import { docRelocatorOf } from "../../src/annotations/relocate";
import type { SidecarAnnotation } from "../../src/annotations/sidecar-model";

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

describe("docRelocatorOf · body fallback text domain", () => {
  it("should not relocate an exact that only appears inside <script>", () => {
    const relocate = docRelocatorOf(
      '<html><body><p>visible text</p><script>marker = "needle"</script></body></html>',
    );
    const result = relocate(
      note({ selector: "body > table:nth-of-type(1)" }),
    );

    expect(result).toEqual({ ok: false, reason: "anchor_lost", via: "body" });
  });
});
