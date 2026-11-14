// 这层管：`annotations/store.ts` 的读回容错（AC2.4）与写回"只拼区间"（AC2.5 的纯函数侧）。
// 每个诊断都断**文本内容**：只说"有诊断"等于没测。

import { describe, expect, it } from "vitest";

import type { Annotation } from "../../src/annotations/model";
import { ANCHOR_LIMITS, NOTE_LIMIT } from "../../src/annotations/model";
import { readAnnotations, writeAnnotations } from "../../src/annotations/store";

const META = '<script id="hr-meta" type="application/json">__PAYLOAD__</script>';

const docWith = (payload: string): string =>
  [
    "<!doctype html><html><body>",
    '<article data-hr-id="hr-a"><p data-hr-id="hr-b">正文</p></article>',
    META.replace("__PAYLOAD__", payload),
    "</body></html>",
  ].join("\n");

const payloadOf = (...annotations: unknown[]): string =>
  JSON.stringify({ version: 1, annotations });

const payloadIn = (html: string): string =>
  /<script id="hr-meta" type="application\/json">([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? "";

const annotationOf = (patch: Partial<Annotation> = {}): Annotation => ({
  id: "an-00000000",
  nodeId: "hr-b",
  anchor: { exact: "正文", prefix: "", suffix: "", start: 0 },
  note: "批注",
  status: "pending",
  createdAt: "2024-01-01T00:00:00.000Z",
  ...patch,
});

describe("readAnnotations · 旧字段映射", () => {
  it("should read M1.x names: targetId, comment and pending_ai", () => {
    const read = readAnnotations(
      docWith(
        payloadOf({
          targetId: "hr-b",
          comment: "旧批注",
          status: "pending_ai",
          createdAt: "2024-01-01T00:00:00.000Z",
          anchor: { exact: "正文" },
        }),
      ),
    );

    expect(read.diagnostics).toEqual([]);
    expect(read.annotations[0]).toMatchObject({
      nodeId: "hr-b",
      note: "旧批注",
      status: "pending",
      anchor: { exact: "正文", prefix: "", suffix: "", start: 0 },
    });
  });

  it("should skip M1.x entries that have no createdAt and say why (compat gap)", () => {
    const read = readAnnotations(
      docWith(payloadOf({ targetId: "hr-b", comment: "旧批注", anchor: { exact: "正文" } })),
    );

    expect(read.annotations).toEqual([]);
    expect(read.diagnostics).toEqual(["annotations[0] 缺少 createdAt，已跳过"]);
  });
});

describe("readAnnotations · 字段归一", () => {
  it("should treat a missing status as pending and keep resolved metadata", () => {
    const read = readAnnotations(
      docWith(
        payloadOf({
          nodeId: "hr-b",
          createdAt: "t",
          anchor: { exact: "x" },
          status: "resolved",
          resolvedAt: "t2",
          resolutionNote: "done",
          note: "n",
        }),
      ),
    );

    expect(read.annotations[0]).toMatchObject({
      status: "resolved",
      resolvedAt: "t2",
      resolutionNote: "done",
    });
  });

  it("should ignore an unknown status instead of dropping the annotation", () => {
    const read = readAnnotations(
      docWith(
        payloadOf({ nodeId: "hr-b", createdAt: "t", anchor: { exact: "x" }, status: "weird" }),
      ),
    );

    expect(read.annotations).toHaveLength(1);
    expect(read.annotations[0]?.status).toBe("pending");
  });
});

describe("readAnnotations · 整块脏 meta 的三种容错", () => {
  it("should return empty with one diagnostic when the payload is not JSON", () => {
    expect(readAnnotations(docWith("{不是 JSON"))).toEqual({
      annotations: [],
      diagnostics: ["hr-meta 不是合法 JSON 对象，按空批注处理"],
    });
  });

  it("should return empty with one diagnostic when the payload is not an object", () => {
    expect(readAnnotations(docWith("[1,2]")).diagnostics).toEqual([
      "hr-meta 不是合法 JSON 对象，按空批注处理",
    ]);
  });

  it("should return empty with one diagnostic when annotations is not an array", () => {
    expect(readAnnotations(docWith('{"annotations":"x"}')).diagnostics).toEqual([
      "hr-meta.annotations 不是数组，按空批注处理",
    ]);
  });

  it("should be empty and silent when the document has no meta script", () => {
    expect(readAnnotations("<html><body><p>x</p></body></html>")).toEqual({
      annotations: [],
      diagnostics: [],
    });
  });
});

describe("readAnnotations · 单条脏数据", () => {
  it("should skip each dirty entry with its own diagnostic", () => {
    const read = readAnnotations(
      docWith(
        payloadOf(
          null,
          { nodeId: "hr-b" },
          { createdAt: "t", anchor: { exact: "x" } },
          { nodeId: "hr-b", createdAt: "t" },
        ),
      ),
    );

    expect(read.annotations).toEqual([]);
    expect(read.diagnostics).toEqual([
      "annotations[0] 不是对象，已跳过",
      "annotations[1] 缺少 createdAt，已跳过",
      "annotations[2] 缺少 nodeId，已跳过",
      "annotations[3] 的 anchor.exact 不是字符串，已跳过",
    ]);
  });

  it("should report unknown fields once, not once per field", () => {
    const read = readAnnotations(
      docWith(payloadOf({ nodeId: "hr-b", createdAt: "t", anchor: { exact: "x" }, a: 1, b: 2 })),
    );

    expect(read.diagnostics).toEqual(["hr-meta 含未知字段：a, b（已忽略）"]);
  });
});

describe("readAnnotations · 超限截断", () => {
  it("should truncate every over-limit field and report each truncation", () => {
    const read = readAnnotations(
      docWith(
        payloadOf({
          nodeId: "hr-b",
          createdAt: "t",
          note: "n".repeat(NOTE_LIMIT + 1),
          anchor: {
            exact: "e".repeat(ANCHOR_LIMITS.exact + 2),
            prefix: "p".repeat(ANCHOR_LIMITS.prefix + 1),
            suffix: "s".repeat(ANCHOR_LIMITS.suffix + 3),
          },
        }),
      ),
    );
    const [annotation] = read.annotations;

    expect(annotation?.note).toHaveLength(NOTE_LIMIT);
    expect(annotation?.anchor.exact).toHaveLength(ANCHOR_LIMITS.exact);
    expect(annotation?.anchor.prefix).toHaveLength(ANCHOR_LIMITS.prefix);
    expect(annotation?.anchor.suffix).toHaveLength(ANCHOR_LIMITS.suffix);
    expect(read.diagnostics).toEqual([
      `anchor.exact 长度 ${String(ANCHOR_LIMITS.exact + 2)} 超过 ${String(ANCHOR_LIMITS.exact)}，已截断`,
      `anchor.prefix 长度 ${String(ANCHOR_LIMITS.prefix + 1)} 超过 ${String(ANCHOR_LIMITS.prefix)}，已截断`,
      `anchor.suffix 长度 ${String(ANCHOR_LIMITS.suffix + 3)} 超过 ${String(ANCHOR_LIMITS.suffix)}，已截断`,
      `note 长度 ${String(NOTE_LIMIT + 1)} 超过 ${String(NOTE_LIMIT)}，已截断`,
    ]);
  });
});

describe("writeAnnotations · 只拼元数据区间", () => {
  it("should replace only the meta script body and keep every other byte", () => {
    const html = docWith("__PAYLOAD__");
    const written = writeAnnotations(html, [annotationOf()]);

    expect(written).toContain('<script id="hr-meta" type="application/json">{"version":1');
    expect(written.replace(payloadIn(written), "__PAYLOAD__")).toBe(html);
  });

  it("should be byte-identical when the same annotations are written twice", () => {
    const html = docWith("{}");
    const first = writeAnnotations(html, [annotationOf()]);

    expect(writeAnnotations(html, [annotationOf()])).toBe(first);
    expect(writeAnnotations(first, readAnnotations(first).annotations)).toBe(first);
  });
});

describe("writeAnnotations · 边界", () => {
  it("should escape </ so a note cannot close the script element", () => {
    const written = writeAnnotations(docWith("{}"), [
      annotationOf({ note: "</script><img onerror=alert(1)>" }),
    ]);

    expect(written).toContain("<\\/script>");
    expect(written.match(/<\/script>/gu)).toHaveLength(1);
    expect(readAnnotations(written).annotations[0]?.note).toBe("</script><img onerror=alert(1)>");
  });

  it("should insert before </body> when the meta script is missing", () => {
    const written = writeAnnotations("<html><body><p>x</p></body></html>", [annotationOf()]);
    const payload = payloadIn(written);

    expect(payload).toContain('"nodeId":"hr-b"');
    expect(written).toBe(
      `<html><body><p>x</p><script id="hr-meta" type="application/json">${payload}</script></body></html>`,
    );
  });

  it("should append when there is no </body> at all", () => {
    expect(writeAnnotations("<p>x</p>", [])).toBe(
      '<p>x</p><script id="hr-meta" type="application/json">{"version":1,"annotations":[]}</script>',
    );
  });
});
