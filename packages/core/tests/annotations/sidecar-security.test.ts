// This layer: hostile input against the pure parser/serializer/relocator — prototype-pollution
// keys anywhere in the payload, oversized payloads staying structurally bounded, and malicious
// selector strings failing flat (never deep, never slow: the grammar is a bounded char scanner).

import { describe, expect, it } from "vitest";

import { docRelocatorOf, parseSelectorPath } from "../../src/annotations/relocate";
import {
  parseSidecarFile,
  serializeSidecarFile,
  SIDECAR_LIMITS,
  type SidecarAnnotation,
} from "../../src/annotations/sidecar-model";

const PATH = "doc.html";
const DOC = "<html><body><div><p>anchor text</p></div></body></html>";

const record: SidecarAnnotation = {
  id: "an-00000000",
  selector: "body > div:nth-of-type(1) > p:nth-of-type(1)",
  anchor: { exact: "anchor", prefix: "", suffix: "", start: 0 },
  note: "n",
  status: "pending",
  createdAt: "t",
  author: "user",
  replies: [],
};

const annotation: SidecarAnnotation = record;

const fileJson = (annotations: unknown): string =>
  JSON.stringify({ version: 1, path: PATH, annotations });

const relocate = (patch: Partial<SidecarAnnotation>) => {
  const annotationIn = { ...annotation, ...patch };
  return docRelocatorOf(DOC)(annotationIn);
};

describe("prototype pollution · dangerous keys are file-level corruption", () => {
  const dangerous = ["__proto__", "constructor", "prototype"];

  it.each(dangerous)("should read empty+corrupt when %s is a top-level key", (key) => {
    const parsed = parseSidecarFile(
      JSON.stringify({ version: 1, path: PATH, annotations: [], [key]: { polluted: true } }),
      PATH,
    );

    expect(parsed.corrupt).toBe(true);
    expect(parsed.annotations).toEqual([]);
    expect(parsed.diagnostics).toEqual([`侧车批注文件含危险键：${key}，按空批注处理`]);
  });

  it.each(dangerous)("should read empty+corrupt when %s hides inside a record", (key) => {
    const dirty = { ...record, [key]: { polluted: true } };
    const parsed = parseSidecarFile(fileJson([record, dirty]), PATH);

    expect(parsed.corrupt).toBe(true);
    expect(parsed.annotations).toEqual([]);
  });

  it.each(dangerous)("should read empty+corrupt when %s hides inside an anchor", (key) => {
    const dirty = { ...record, anchor: { exact: "a", [key]: {} } };
    expect(parseSidecarFile(fileJson([dirty]), PATH).corrupt).toBe(true);
  });

  it.each(dangerous)("should read empty+corrupt when %s hides inside a reply", (key) => {
    const dirty = {
      ...record,
      replies: [{ id: "rp-1", author: "user", note: "x", createdAt: "t", [key]: {} }],
    };
    expect(parseSidecarFile(fileJson([dirty]), PATH).corrupt).toBe(true);
  });

  it("should not let a parsed payload mutate Object.prototype", () => {
    parseSidecarFile(fileJson([record]), PATH);
    const fresh: Record<string, unknown> = {};
    const prototype: Record<string, unknown> = Object.prototype as Record<string, unknown>;
    expect(fresh["polluted"]).toBeUndefined();
    expect(prototype["polluted"]).toBeUndefined();
  });

  it("should treat toString/hasOwnProperty as ordinary unknown fields, not corruption", () => {
    const parsed = parseSidecarFile(
      fileJson([{ ...record, toString: 1, hasOwnProperty: 2 }]),
      PATH,
    );

    expect(parsed.corrupt).toBe(false);
    expect(parsed.annotations).toHaveLength(1);
    expect(parsed.diagnostics).toEqual([
      "侧车批注文件含未知字段：toString, hasOwnProperty（已忽略）",
    ]);
  });

  it("should serialize records whose note merely mentions dangerous keys without harm", () => {
    const noted: SidecarAnnotation = { ...annotation, note: "__proto__ constructor prototype" };
    const parsed = parseSidecarFile(serializeSidecarFile(PATH, [noted]), PATH);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.annotations[0]?.note).toBe(noted.note);
  });
});

describe("size bounds · oversized payloads stay structurally capped", () => {
  it(
    "should cap annotations at the limit with a truncation diagnostic",
    { timeout: 20_000 },
    () => {
      const many = Array.from({ length: SIDECAR_LIMITS.annotations + 500 }, (_u, index) => ({
        ...record,
        id: `an-${String(index)}`,
      }));
      const parsed = parseSidecarFile(fileJson(many), PATH);

      expect(parsed.corrupt).toBe(false);
      expect(parsed.annotations).toHaveLength(SIDECAR_LIMITS.annotations);
      expect(parsed.diagnostics).toEqual([
        `批注数 ${String(SIDECAR_LIMITS.annotations + 500)} 超过 ${String(SIDECAR_LIMITS.annotations)}，已截断`,
      ]);
    },
  );

  it("should cap replies at the limit with a truncation diagnostic", () => {
    const many = {
      ...record,
      replies: Array.from({ length: SIDECAR_LIMITS.replies + 50 }, (_u, index) => ({
        id: `rp-${String(index)}`,
        author: "user",
        note: "r",
        createdAt: "t",
      })),
    };
    const parsed = parseSidecarFile(fileJson([many]), PATH);

    expect(parsed.annotations[0]?.replies).toHaveLength(SIDECAR_LIMITS.replies);
    expect(parsed.diagnostics).toEqual([
      `annotations[0].replies 长度 ${String(SIDECAR_LIMITS.replies + 50)} 超过 ${String(SIDECAR_LIMITS.replies)}，已截断`,
    ]);
  });

  it("should keep working when a record field is deeply nested", { timeout: 20_000 }, () => {
    // The danger scan is an explicit worklist, not recursion — depth cannot blow the stack.
    let deep: unknown = { leaf: true };
    for (let index = 0; index < 200; index += 1) deep = { wrap: deep };
    const parsed = parseSidecarFile(fileJson([{ ...record, extra: deep }]), PATH);

    expect(parsed.corrupt).toBe(false);
    expect(parsed.annotations).toHaveLength(1);
  });
});

describe("malicious selectors · invalid input fails flat", () => {
  it.each([
    ["empty", ""],
    ["a stray combinator", "> body"],
    ["a doubled combinator", "body >> p"],
    ["a trailing combinator", "body > div >"],
    ["a non-numeric nth", "p:nth-of-type(abc)"],
    ["nth zero", "p:nth-of-type(0)"],
    ["nth over the cap", "p:nth-of-type(10000)"],
    ["an unclosed nth", "p:nth-of-type(12"],
    ["an unknown pseudo", "p:nth-child(2)"],
    ["a redos-shaped repeat", "p:nth-of-type(1):nth-of-type(1):nth-of-type(1)"],
    ["an attribute selector", "p[data-x='y']"],
    ["a universal star", "* > p"],
    ["a namespace pipe", "svg|rect"],
    ["a class suffix", "p.note"],
    ["an id suffix", "p#x"],
    ["javascript scheme text", "javascript:alert(1)"],
    ["a step cap bust", Array.from({ length: 80 }, () => "a").join(">")],
    ["a char cap bust", `body > ${"a".repeat(2000)}`],
  ])("should parse %s as undefined", (_label, selector) => {
    expect(parseSelectorPath(selector)).toBeUndefined();
  });

  it.each([
    ["an overlong selector", `body > ${"a".repeat(5000)}`],
    ["a step-cap bust", Array.from({ length: 200 }, () => "div").join(" > ")],
    ["an unparseable soup", "body > div:not(.a):hover::before[title*='x'] > p"],
    ["an nth flood", "p:nth-of-type(99999999999999999999)"],
  ])(
    "should fall back to body text when the selector is %s",
    { timeout: 10_000 },
    (_label, selector) => {
      const result = relocate({ selector });

      expect(result).toMatchObject({ ok: true, via: "body" });
    },
  );

  it("should still match a selector buried in whitespace and case differences", () => {
    const result = relocate({ selector: "  BODY  >  div:nth-of-type(1)  " });

    expect(result).toMatchObject({ ok: true, via: "selector" });
  });
});
