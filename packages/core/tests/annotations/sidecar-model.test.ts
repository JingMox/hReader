// This layer: `annotations/sidecar-model.ts` — dirty-read normalization, file-level corruption,
// deterministic serialization, and record limits. Pure functions fed directly; every diagnostic
// asserts its text, not just its presence.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { NOTE_LIMIT, type TextAnchor } from "../../src/annotations/model";
import {
  parseSidecarFile,
  replyIdOf,
  serializeSidecarFile,
  SIDECAR_LIMITS,
  type SidecarAnnotation,
} from "../../src/annotations/sidecar-model";

const PATH = "docs/report.html";

// `| undefined` on every key lets a patch *remove* a default (e.g. selector) under
// exactOptionalPropertyTypes; undefined entries are deleted, not spread.
type SidecarPatch = { [K in keyof SidecarAnnotation]?: SidecarAnnotation[K] | undefined };

const annotationOf = (patch: SidecarPatch = {}): SidecarAnnotation => {
  const base: Record<string, unknown> = {
    id: "an-00000000",
    selector: "body > p:nth-of-type(1)",
    anchor: { exact: "正文", prefix: "", suffix: "", start: 0 },
    note: "批注",
    status: "pending",
    createdAt: "2024-01-01T00:00:00.000Z",
    author: "user",
    replies: [],
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) Reflect.deleteProperty(base, key);
    else base[key] = value;
  }
  return base as unknown as SidecarAnnotation;
};

const fileOf = (...annotations: unknown[]): string =>
  JSON.stringify({ version: 1, path: PATH, annotations });

const validRecord = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "an-00000000",
  selector: "body > p:nth-of-type(1)",
  anchor: { exact: "正文" },
  note: "批注",
  status: "pending",
  createdAt: "2024-01-01T00:00:00.000Z",
  author: "user",
  replies: [],
  ...patch,
});

describe("parseSidecarFile · file-level corruption reads as empty", () => {
  it.each([
    ["bad JSON", "{oops"],
    ["a BOM", `\uFEFF${fileOf()}`],
    ["an array instead of an object", "[]"],
    ["null", "null"],
    ["a scalar", '"x"'],
    ["an unknown version", JSON.stringify({ version: 2, path: PATH, annotations: [] })],
    ["a missing version", JSON.stringify({ path: PATH, annotations: [] })],
    ["a path mismatch", JSON.stringify({ version: 1, path: "other.html", annotations: [] })],
    ["a non-string path", JSON.stringify({ version: 1, path: 42, annotations: [] })],
    ["non-array annotations", JSON.stringify({ version: 1, path: PATH, annotations: {} })],
  ])("should read empty with one diagnostic and corrupt=true for %s", (_label, text) => {
    const parsed = parseSidecarFile(text, PATH);

    expect(parsed.annotations).toEqual([]);
    expect(parsed.corrupt).toBe(true);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatch(/按空批注处理/u);
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "should read empty when a dangerous key %s appears at the top level",
    (key) => {
      const parsed = parseSidecarFile(
        `{"version":1,"path":"${PATH}","${key}":{},"annotations":[]}`,
        PATH,
      );

      expect(parsed.annotations).toEqual([]);
      expect(parsed.corrupt).toBe(true);
      expect(parsed.diagnostics).toEqual([`侧车批注文件含危险键：${key}，按空批注处理`]);
    },
  );

  it("should read empty when a dangerous key hides inside a nested record", () => {
    const text = JSON.stringify({
      version: 1,
      path: PATH,
      annotations: [validRecord({ anchor: { exact: "正文", constructor: "x" } })],
    });

    const parsed = parseSidecarFile(text, PATH);

    expect(parsed.annotations).toEqual([]);
    expect(parsed.corrupt).toBe(true);
    expect(parsed.diagnostics).toEqual(["侧车批注文件含危险键：constructor，按空批注处理"]);
  });

  it("should not pollute prototypes when dangerous keys are present", () => {
    parseSidecarFile(
      `{"version":1,"path":"${PATH}","__proto__":{"polluted":true},"annotations":[]}`,
      PATH,
    );

    expect(Reflect.get({}, "polluted")).toBeUndefined();
  });
});

describe("parseSidecarFile · per-record dirt", () => {
  it("should skip each dirty entry with its own diagnostic and stay non-corrupt", () => {
    const parsed = parseSidecarFile(
      fileOf(
        null,
        { selector: "body > p", anchor: { exact: "x" }, createdAt: "t" },
        { id: "a", anchor: { exact: "x" }, createdAt: "t" },
        { id: "a", nodeId: "hr-b", anchor: { exact: "x" } },
        { id: "a", nodeId: "hr-b", createdAt: "t" },
      ),
      PATH,
    );

    expect(parsed.corrupt).toBe(false);
    expect(parsed.annotations).toEqual([]);
    expect(parsed.diagnostics).toEqual([
      "annotations[0] 不是对象，已跳过",
      "annotations[1] 缺少 id，已跳过",
      "annotations[2] 缺少 nodeId/selector，已跳过",
      "annotations[3] 缺少 createdAt，已跳过",
      "annotations[4] 的 anchor.exact 不是字符串，已跳过",
    ]);
  });

  it("should keep the first record when ids repeat and skip later duplicates", () => {
    const parsed = parseSidecarFile(
      fileOf(validRecord({ note: "第一条" }), validRecord({ note: "第二条" })),
      PATH,
    );

    expect(parsed.annotations).toHaveLength(1);
    expect(parsed.annotations[0]?.note).toBe("第一条");
    expect(parsed.diagnostics).toEqual(["批注 id 重复：an-00000000，已跳过"]);
  });

  it("should report unknown fields once, not once per field", () => {
    const parsed = parseSidecarFile(
      fileOf(validRecord({ a: 1, b: 2 }), validRecord({ id: "an-11111111", a: 3 })),
      PATH,
    );

    expect(parsed.annotations).toHaveLength(2);
    expect(parsed.diagnostics).toEqual(["侧车批注文件含未知字段：a, b（已忽略）"]);
  });

  it("should normalize status and lifecycle fields like the meta reader", () => {
    const parsed = parseSidecarFile(
      fileOf(
        validRecord({ status: "pending_ai" }),
        validRecord({
          id: "an-22222222",
          status: "resolved",
          resolvedAt: "t2",
          resolutionNote: "done",
        }),
        validRecord({ id: "an-33333333", status: "weird" }),
      ),
      PATH,
    );

    expect(parsed.annotations[0]?.status).toBe("pending");
    expect(parsed.annotations[1]).toMatchObject({
      status: "resolved",
      resolvedAt: "t2",
      resolutionNote: "done",
    });
    expect(parsed.annotations[2]?.status).toBe("pending");
    expect(parsed.diagnostics).toEqual([]);
  });

  it("should truncate over-limit fields and report each truncation", () => {
    const parsed = parseSidecarFile(
      fileOf(
        validRecord({
          note: "n".repeat(NOTE_LIMIT + 1),
          anchor: { exact: "e".repeat(600), prefix: "p".repeat(70), suffix: "s".repeat(70) },
        }),
      ),
      PATH,
    );

    const [annotation] = parsed.annotations;
    expect(annotation?.note).toHaveLength(NOTE_LIMIT);
    expect(annotation?.anchor.exact).toHaveLength(500);
    expect(parsed.diagnostics).toEqual([
      "anchor.exact 长度 600 超过 500，已截断",
      "anchor.prefix 长度 70 超过 64，已截断",
      "anchor.suffix 长度 70 超过 64，已截断",
      `annotations[0].note 长度 ${String(NOTE_LIMIT + 1)} 超过 ${String(NOTE_LIMIT)}，已截断`,
    ]);
  });
});

describe("parseSidecarFile · replies", () => {
  it("should ignore a non-array replies field with a diagnostic", () => {
    const parsed = parseSidecarFile(fileOf(validRecord({ replies: "x" })), PATH);

    expect(parsed.annotations[0]?.replies).toEqual([]);
    expect(parsed.diagnostics).toEqual(["annotations[0].replies 不是数组，已忽略"]);
  });

  it("should skip each dirty reply with its own diagnostic", () => {
    const parsed = parseSidecarFile(
      fileOf(
        validRecord({
          replies: [null, { note: "x" }, { id: "rp-1" }, { id: "rp-2", createdAt: "t", note: 1 }],
        }),
      ),
      PATH,
    );

    expect(parsed.annotations[0]?.replies).toEqual([
      { id: "rp-2", author: "user", note: "", createdAt: "t" },
    ]);
    expect(parsed.diagnostics).toEqual([
      "annotations[0].replies[0] 不是对象，已跳过",
      "annotations[0].replies[1] 缺少 id，已跳过",
      "annotations[0].replies[2] 缺少 createdAt，已跳过",
    ]);
  });

  it("should cap replies at the limit and truncate over-long reply notes", () => {
    const replies = Array.from({ length: SIDECAR_LIMITS.replies + 2 }, (_unused, index) => ({
      id: `rp-${String(index)}`,
      createdAt: "t",
      note: index === 0 ? "r".repeat(NOTE_LIMIT + 1) : "r",
      author: index === 1 ? "agent" : "user",
    }));

    const parsed = parseSidecarFile(fileOf(validRecord({ replies })), PATH);

    expect(parsed.annotations[0]?.replies).toHaveLength(SIDECAR_LIMITS.replies);
    expect(parsed.annotations[0]?.replies[0]?.note).toHaveLength(NOTE_LIMIT);
    expect(parsed.annotations[0]?.replies[1]?.author).toBe("agent");
    expect(parsed.diagnostics).toEqual([
      `annotations[0].replies[0].note 长度 ${String(NOTE_LIMIT + 1)} 超过 ${String(NOTE_LIMIT)}，已截断`,
      `annotations[0].replies 长度 ${String(SIDECAR_LIMITS.replies + 2)} 超过 ${String(SIDECAR_LIMITS.replies)}，已截断`,
    ]);
  });
});

describe("parseSidecarFile · the annotations cap", () => {
  it("should cap a file beyond the annotation limit and report the truncation", () => {
    const annotations = Array.from({ length: SIDECAR_LIMITS.annotations + 1 }, (_u, index) =>
      validRecord({ id: `an-${String(index).padStart(8, "0")}` }),
    );

    const parsed = parseSidecarFile(fileOf(...annotations), PATH);

    expect(parsed.annotations).toHaveLength(SIDECAR_LIMITS.annotations);
    expect(parsed.diagnostics).toEqual([
      `批注数 ${String(SIDECAR_LIMITS.annotations + 1)} 超过 ${String(SIDECAR_LIMITS.annotations)}，已截断`,
    ]);
  });

  it("should accept a file exactly at the annotation limit", () => {
    const annotations = Array.from({ length: SIDECAR_LIMITS.annotations }, (_u, index) =>
      validRecord({ id: `an-${String(index).padStart(8, "0")}` }),
    );

    const parsed = parseSidecarFile(fileOf(...annotations), PATH);

    expect(parsed.annotations).toHaveLength(SIDECAR_LIMITS.annotations);
    expect(parsed.diagnostics).toEqual([]);
  });
});

describe("parseSidecarFile · character sets", () => {
  it("should round-trip CJK, ZWJ emoji, RTL and combining marks verbatim", () => {
    const annotation = annotationOf({
      note: "中文批注 👨‍👩‍👧‍👦 مرحبا é̶",
      anchor: { exact: "é̶ 正̃文 👨‍👩‍👧", prefix: "مرحبا", suffix: "中文", start: 0 },
    });

    const parsed = parseSidecarFile(serializeSidecarFile(PATH, [annotation]), PATH);

    expect(parsed.annotations[0]?.note).toBe("中文批注 👨‍👩‍👧‍👦 مرحبا é̶");
    expect(parsed.annotations[0]?.anchor).toEqual(annotation.anchor);
    expect(parsed.diagnostics).toEqual([]);
  });
});

describe("serializeSidecarFile · determinism", () => {
  it("should be byte-identical for the same input and parse back to the same record", () => {
    const annotations = [
      annotationOf(),
      annotationOf({
        id: "an-11111111",
        nodeId: "hr-b",
        resolvedAt: "t2",
        resolutionNote: "done",
        status: "resolved",
        author: "agent",
        replies: [{ id: "rp-1", author: "agent", note: "回复", createdAt: "t3" }],
      }),
      annotationOf({ id: "an-22222222", selector: undefined, nodeId: "hr-c" }),
    ];
    const first = serializeSidecarFile(PATH, annotations);

    expect(serializeSidecarFile(PATH, annotations)).toBe(first);
    const parsed = parseSidecarFile(first, PATH);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.annotations).toEqual(annotations);
    expect(parsed.diagnostics).toEqual([]);
  });
});

describe("replyIdOf · deterministic content hash", () => {
  it("should mint the same id for the same input and different ids for a second reply", () => {
    const base = { annotationId: "an-1", note: "回复", createdAt: "t", ordinal: 0 };

    expect(replyIdOf(base)).toBe(replyIdOf(base));
    expect(replyIdOf(base)).toMatch(/^rp-[0-9a-f]{8}$/u);
    expect(replyIdOf({ ...base, ordinal: 1 })).not.toBe(replyIdOf(base));
  });
});

describe("property · serialize → parse round-trip", () => {
  const anchorArb: fc.Arbitrary<TextAnchor> = fc.record({
    exact: fc.string({ maxLength: 80 }),
    prefix: fc.string({ maxLength: 60 }),
    suffix: fc.string({ maxLength: 60 }),
    start: fc.nat({ max: 100_000 }),
  });
  const replyArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 16 }),
    author: fc.constantFrom("user", "agent"),
    note: fc.string({ maxLength: 120 }),
    createdAt: fc.string({ maxLength: 30 }),
  });
  // fc.option emits the key with value undefined; exactOptionalPropertyTypes wants it absent.
  const annotationArb: fc.Arbitrary<SidecarAnnotation> = fc
    .record({
      id: fc.string({ minLength: 1, maxLength: 16 }),
      nodeId: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
      selector: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
      anchor: anchorArb,
      note: fc.string({ maxLength: 120 }),
      status: fc.constantFrom("pending", "resolved"),
      createdAt: fc.string({ minLength: 1, maxLength: 30 }),
      resolvedAt: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
      resolutionNote: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
      author: fc.constantFrom("user", "agent"),
      replies: fc.array(replyArb, { maxLength: 5 }),
    })
    .map(
      (item) =>
        Object.fromEntries(
          Object.entries(item).filter(([, value]) => value !== undefined),
        ) as unknown as SidecarAnnotation,
    )
    .filter((item) => item.nodeId !== undefined || item.selector !== undefined);

  it("should parse back an identical record set for arbitrary clean annotations", () => {
    fc.assert(
      fc.property(fc.uniqueArray(annotationArb, { selector: (item) => item.id }), (items) => {
        const parsed = parseSidecarFile(serializeSidecarFile(PATH, items), PATH);
        expect(parsed.corrupt).toBe(false);
        expect(parsed.annotations).toEqual(items);
        expect(parsed.diagnostics).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });
});
