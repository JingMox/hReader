// This layer: `annotations/relocate.ts` — the structural selector grammar, element lookup,
// and anchor relocation across all three document classes. Failure modes are values asserted
// by name (`orphaned` / `anchor_lost` / `ambiguous`), and a lost anchor never deletes anything.

import { describe, expect, it } from "vitest";

import { parseHtml } from "../../src/html/parse";
import {
  docRelocatorOf,
  elementByPath,
  parseSelectorPath,
  SELECTOR_LIMITS,
} from "../../src/annotations/relocate";
import type { SidecarAnnotation } from "../../src/annotations/sidecar-model";

const MANAGED = [
  "<!doctype html>",
  '<html><body><article data-hr-id="hr-a"><p data-hr-id="hr-b">正文一</p><p data-hr-id="hr-c">正文二</p></article></body></html>',
].join("\n");

const NORMALIZABLE =
  '<html><body><article><p data-hr-id="x">可归一的文本</p></article></body></html>';

const FOREIGN =
  "<html><body><div><p>hello world</p><p>second paragraph</p></div><ul><li>item</li></ul></body></html>";

const note = (patch: Partial<SidecarAnnotation> = {}): SidecarAnnotation => ({
  id: "an-00000000",
  anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
  note: "",
  status: "pending",
  createdAt: "2024-01-01T00:00:00.000Z",
  author: "user",
  replies: [],
  ...patch,
});

describe("parseSelectorPath · grammar", () => {
  it.each([
    ["body", [{ tag: "body", nth: 1 }]],
    [
      "body > div:nth-of-type(2) > p:nth-of-type(3)",
      [
        { tag: "body", nth: 1 },
        { tag: "div", nth: 2 },
        { tag: "p", nth: 3 },
      ],
    ],
    [
      "BODY > P",
      [
        { tag: "body", nth: 1 },
        { tag: "p", nth: 1 },
      ],
    ],
    [
      "body  >  p:NTH-OF-TYPE(2)",
      [
        { tag: "body", nth: 1 },
        { tag: "p", nth: 2 },
      ],
    ],
    [
      "my-tag > x1",
      [
        { tag: "my-tag", nth: 1 },
        { tag: "x1", nth: 1 },
      ],
    ],
  ])("should parse %s into steps", (input, steps) => {
    expect(parseSelectorPath(input)).toEqual(steps);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["starts with >", ">p"],
    ["trailing >", "p>"],
    ["space-separated steps", "p p"],
    ["a space before the pseudo", "div :nth-of-type(2)"],
    ["an unknown pseudo", "p:first-child"],
    ["nth of zero", "p:nth-of-type(0)"],
    ["nth above the bound", `p:nth-of-type(${String(SELECTOR_LIMITS.nth + 1)})`],
    ["nth without digits", "p:nth-of-type()"],
    ["unclosed pseudo", "p:nth-of-type(1"],
    ["over-length", `p:nth-of-type(${"9".repeat(SELECTOR_LIMITS.chars)})`],
  ])("should return undefined for %s", (_label, input) => {
    expect(parseSelectorPath(input)).toBeUndefined();
  });

  it("should return undefined when the step count exceeds the bound", () => {
    const steps = Array.from({ length: SELECTOR_LIMITS.steps + 1 }, () => "p").join(" > ");

    expect(parseSelectorPath(steps)).toBeUndefined();
  });

  it("should accept exactly the step bound", () => {
    const steps = Array.from({ length: SELECTOR_LIMITS.steps }, () => "p").join(" > ");

    expect(parseSelectorPath(steps)).toHaveLength(SELECTOR_LIMITS.steps);
  });
});

describe("elementByPath · lookup", () => {
  const root = parseHtml(FOREIGN).root;

  it("should return undefined for an empty step list", () => {
    expect(elementByPath(root, [])).toBeUndefined();
  });

  it("should find the nth same-tag child of a matched element", () => {
    const element = elementByPath(
      root,
      parseSelectorPath("body > div:nth-of-type(1) > p:nth-of-type(2)") ?? [],
    );

    expect(element?.tag).toBe("p");
    expect(element?.children[0]).toMatchObject({ kind: "text", value: "second paragraph" });
  });

  it("should evaluate an html-anchored path from the document root", () => {
    const element = elementByPath(
      root,
      parseSelectorPath("html > body > ul:nth-of-type(1) > li:nth-of-type(1)") ?? [],
    );

    expect(element?.tag).toBe("li");
  });

  it("should return undefined when a middle step cannot match", () => {
    expect(
      elementByPath(root, parseSelectorPath("body > table:nth-of-type(1) > tr") ?? []),
    ).toBeUndefined();
  });

  it("should return undefined when the body itself does not satisfy nth-of-type", () => {
    expect(elementByPath(root, parseSelectorPath("body:nth-of-type(2)") ?? [])).toBeUndefined();
  });

  it("should descend from an element root, not only the document root", () => {
    const html = elementByPath(root, parseSelectorPath("html") ?? []);

    const element = elementByPath(
      html ?? root,
      parseSelectorPath("body > ul:nth-of-type(1)") ?? [],
    );

    expect(element?.tag).toBe("ul");
  });

  it("should return undefined when the root is a text node", () => {
    const textRoot = { kind: "text" as const, value: "x" };

    expect(elementByPath(textRoot, parseSelectorPath("body") ?? [])).toBeUndefined();
  });
});

describe("docRelocatorOf · selector relocation", () => {
  it("should resolve inside the element text and report body-text offsets tagged via=selector", () => {
    const relocate = docRelocatorOf(FOREIGN);
    const result = relocate(
      note({
        selector: "body > div:nth-of-type(1) > p:nth-of-type(2)",
        anchor: { exact: "second", prefix: "", suffix: "", start: 0 },
      }),
    );

    // D49: start/end index into bodyTextOf — "second" sits at [11,17) of
    // "hello worldsecond paragraphitem", not at [0,6) of the element's own text.
    expect(result).toEqual({ ok: true, start: 11, end: 17, via: "selector" });
  });

  it("should fall back to the body text when the selector no longer matches", () => {
    const relocate = docRelocatorOf(FOREIGN);
    const result = relocate(
      note({
        selector: "body > table:nth-of-type(1)",
        anchor: { exact: "item", prefix: "", suffix: "", start: 0 },
      }),
    );

    expect(result).toEqual({ ok: true, start: 27, end: 31, via: "body" });
  });

  it("should report anchor_lost via=body when neither the element nor the body text matches", () => {
    const relocate = docRelocatorOf(FOREIGN);
    const result = relocate(
      note({
        selector: "body > table:nth-of-type(9)",
        anchor: { exact: "不存在", prefix: "", suffix: "", start: 0 },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "anchor_lost", via: "body" });
  });

  it("should report ambiguous via=body when every level fails the same disambiguation", () => {
    const relocate = docRelocatorOf("<body><p>AB AB</p></body>");
    const result = relocate(
      note({
        selector: "body > p:nth-of-type(1)",
        anchor: { exact: "AB", prefix: "X", suffix: "Y", start: 0 },
      }),
    );

    // D49: a selector-level miss falls through to the body level, which reports
    // the final verdict — same text, same ambiguous outcome, via=body.
    expect(result).toEqual({ ok: false, reason: "ambiguous", via: "body" });
  });

  it("should disambiguate a repeated quote with prefix and suffix inside the element", () => {
    const relocate = docRelocatorOf("<body><p>先 AB 中 AB 后</p></body>");
    const result = relocate(
      note({
        selector: "body > p:nth-of-type(1)",
        anchor: { exact: "AB", prefix: "先 ", suffix: " 中", start: 0 },
      }),
    );

    expect(result).toEqual({ ok: true, start: 2, end: 4, via: "selector" });
  });

  it("should treat an unparseable selector as a miss and fall back to the body", () => {
    const relocate = docRelocatorOf(FOREIGN);
    const result = relocate(
      note({
        selector: "((((( not css )))))",
        anchor: { exact: "item", prefix: "", suffix: "", start: 0 },
      }),
    );

    expect(result).toEqual({ ok: true, start: 27, end: 31, via: "body" });
  });
});

describe("docRelocatorOf · nodeId relocation by document class", () => {
  it("should keep the nodeId level on a managed document and report body-text offsets", () => {
    const relocate = docRelocatorOf(MANAGED);
    const hit = relocate(
      note({ nodeId: "hr-b", anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 } }),
    );

    expect(hit).toEqual({ ok: true, start: 0, end: 3, via: "node" });
  });

  it("should fall back to the body text when the nodeId is gone (D49)", () => {
    const relocate = docRelocatorOf(MANAGED);
    const missing = relocate(note({ nodeId: "hr-gone" }));

    expect(missing).toEqual({ ok: true, start: 0, end: 3, via: "body" });
  });

  it("should fall back to the body text when the node exists but the anchor does not (D49)", () => {
    const relocate = docRelocatorOf(MANAGED);
    const result = relocate(
      note({ nodeId: "hr-c", anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 } }),
    );

    // 正文一 lives in hr-b's block, outside hr-c's slice — the node level misses
    // and the body level relocates it.
    expect(result).toEqual({ ok: true, start: 0, end: 3, via: "body" });
  });

  it("should find a nodeId through a data-hr-id scan on a normalizable document", () => {
    const relocate = docRelocatorOf(NORMALIZABLE);
    const hit = relocate(
      note({ nodeId: "x", anchor: { exact: "可归一的文本", prefix: "", suffix: "", start: 0 } }),
    );

    expect(hit).toEqual({ ok: true, start: 0, end: 6, via: "node" });
  });

  it("should fall back to the body text when the nodeId is gone on a normalizable document (D49)", () => {
    const relocate = docRelocatorOf(NORMALIZABLE);
    const missing = relocate(
      note({
        nodeId: "x-gone",
        anchor: { exact: "可归一的文本", prefix: "", suffix: "", start: 0 },
      }),
    );

    expect(missing).toEqual({ ok: true, start: 0, end: 6, via: "body" });
  });

  it("should resolve a nodeId on a foreign document through the attribute scan", () => {
    const relocate = docRelocatorOf('<div data-hr-id="a1">外部文本</div>');
    const result = relocate(
      note({ nodeId: "a1", anchor: { exact: "外部文本", prefix: "", suffix: "", start: 0 } }),
    );

    expect(result).toEqual({ ok: true, start: 0, end: 4, via: "node" });
  });

  it("should prefer nodeId over a selector when both are present", () => {
    const relocate = docRelocatorOf(MANAGED);
    const result = relocate(
      note({
        nodeId: "hr-c",
        selector: "body > p:nth-of-type(1)",
        anchor: { exact: "正文二", prefix: "", suffix: "", start: 0 },
      }),
    );

    // D49: offsets index into bodyTextOf — 正文二 sits at [3,6) of "正文一正文二".
    expect(result).toEqual({ ok: true, start: 3, end: 6, via: "node" });
  });

  it("should report orphaned via=none when the record carries no locating info", () => {
    const relocate = docRelocatorOf(MANAGED);

    expect(relocate(note())).toEqual({ ok: false, reason: "orphaned", via: "none" });
  });
});

describe("docRelocatorOf · D49 fallback chain levels", () => {
  it("should fall back nodeId → selector when the node is gone but the selector still matches", () => {
    const relocate = docRelocatorOf(MANAGED);
    const result = relocate(
      note({
        nodeId: "hr-gone",
        selector: "body > article:nth-of-type(1) > p:nth-of-type(2)",
        anchor: { exact: "正文二", prefix: "", suffix: "", start: 0 },
      }),
    );

    expect(result).toEqual({ ok: true, start: 3, end: 6, via: "selector" });
  });

  it("should fall back nodeId → selector → body when only the quote survives", () => {
    const relocate = docRelocatorOf(MANAGED);
    const result = relocate(
      note({
        nodeId: "hr-gone",
        selector: "body > table:nth-of-type(1)",
        anchor: { exact: "正文二", prefix: "", suffix: "", start: 0 },
      }),
    );

    expect(result).toEqual({ ok: true, start: 3, end: 6, via: "body" });
  });

  it("should fall back selector → body when the element exists but the anchor left it (D49)", () => {
    const relocate = docRelocatorOf(FOREIGN);
    const result = relocate(
      note({
        selector: "body > ul:nth-of-type(1)",
        anchor: { exact: "second", prefix: "", suffix: "", start: 0 },
      }),
    );

    // The <ul> exists ("item") but "second" is not inside it: the selector level
    // misses and the body level finds it inside the div.
    expect(result).toEqual({ ok: true, start: 11, end: 17, via: "body" });
  });

  it("should report the body verdict when every level misses", () => {
    const relocate = docRelocatorOf(MANAGED);
    const result = relocate(
      note({
        nodeId: "hr-gone",
        selector: "body > table:nth-of-type(1)",
        anchor: { exact: "不存在", prefix: "", suffix: "", start: 0 },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "anchor_lost", via: "body" });
  });

  it("should keep exact+context disambiguation mandatory at every level", () => {
    const relocate = docRelocatorOf('<body><div data-hr-id="n1">AB AB</div><p>先 AB 后</p></body>');
    const result = relocate(
      note({
        nodeId: "n1",
        anchor: { exact: "AB", prefix: "先 ", suffix: " 后", start: 0 },
      }),
    );

    // Inside the node slice the two "AB" hits fit neither context → ambiguous at
    // the node level; the body level still finds the context-fitting one.
    expect(result).toEqual({ ok: true, start: 7, end: 9, via: "body" });
  });

  it("should descend to body when the selector resolves inside a skipped subtree", () => {
    // <noscript> content stays in the parsed tree but contributes no body-text
    // span: the selector finds the element, the level still yields no region.
    const relocate = docRelocatorOf(
      "<body><noscript><p>AB</p></noscript><p>先 AB 后</p></body>",
    );
    const result = relocate(
      note({
        selector: "body > noscript:nth-of-type(1) > p:nth-of-type(1)",
        anchor: { exact: "AB", prefix: "先 ", suffix: " 后", start: 0 },
      }),
    );

    expect(result).toEqual({ ok: true, start: 2, end: 4, via: "body" });
  });
});

describe("docRelocatorOf · degenerate documents", () => {
  it("should report anchor_lost against an empty document", () => {
    const relocate = docRelocatorOf("");
    const result = relocate(
      note({ selector: "body > p", anchor: { exact: "x", prefix: "", suffix: "", start: 0 } }),
    );

    expect(result).toEqual({ ok: false, reason: "anchor_lost", via: "body" });
  });

  it("should match selector steps on a managed document too", () => {
    const relocate = docRelocatorOf(MANAGED);
    const result = relocate(
      note({
        selector: "body > article:nth-of-type(1) > p:nth-of-type(2)",
        anchor: { exact: "正文二", prefix: "", suffix: "", start: 0 },
      }),
    );

    // D49: body-text offsets — 正文二 sits at [3,6).
    expect(result).toEqual({ ok: true, start: 3, end: 6, via: "selector" });
  });
});
