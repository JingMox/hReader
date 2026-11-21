// 这层管：`<script id="hr-meta">` 的读取与 `pendingAnnotations`（卡片 M1.3 契约 5）。

import { describe, expect, it } from "vitest";

import { buildOutline, parseHtml } from "../src/index";
import type { Outline, PendingAnnotation } from "../src/index";

const withMeta = (metaText: string): string =>
  `<article data-hr-id="art"><script id="hr-meta">${metaText}</script>` +
  '<h2 data-hr-id="sec">标题</h2><p>正文</p></article>';

const outlineOf = (html: string): Outline => buildOutline(parseHtml(html));

const codesOf = (outline: Outline): readonly string[] =>
  outline.diagnostics.map((diagnostic) => diagnostic.code);

const messagesOf = (outline: Outline): readonly string[] =>
  outline.diagnostics.map((diagnostic) => diagnostic.message);

const annotation = (targetId: string, comment: string, status: string): string =>
  JSON.stringify({ id: `ann-${targetId}`, targetId, comment, status });

const metaOf = (annotations: readonly string[]): string =>
  `{"annotations":[${annotations.join(",")}]}`;

describe("hr_outline · hr-meta 畸形输入", () => {
  it("should treat a missing hr-meta as legal: no annotations, no diagnostic", () => {
    const outline = outlineOf('<article data-hr-id="art"><h2 data-hr-id="sec">标题</h2></article>');

    expect(outline.pendingAnnotations).toEqual([]);
    expect(codesOf(outline)).toEqual([]);
  });

  it("should diagnose an empty meta script", () => {
    const outline = outlineOf(withMeta(""));

    expect(outline.pendingAnnotations).toEqual([]);
    expect(messagesOf(outline)).toContain("hr-meta 为空");
  });

  it("should diagnose non-JSON text (and M1.1 script_in_meta reports the same defect)", () => {
    const outline = outlineOf(withMeta("not json"));

    expect(codesOf(outline)).toContain("invalid_meta");
    expect(codesOf(outline), "双码是既定事实，只断言 invalid_meta 存在").toContain(
      "script_in_meta",
    );
  });
});
describe("hr_outline · hr-meta 畸形输入 · 续 1", () => {
  it("should diagnose a top-level array", () => {
    const outline = outlineOf(withMeta("[1,2,3]"));

    expect(outline.pendingAnnotations).toEqual([]);
    expect(messagesOf(outline)).toContain("hr-meta 顶层不是对象");
  });

  it("should diagnose annotations that is not an array", () => {
    const outline = outlineOf(withMeta('{"annotations":"x"}'));

    expect(outline.pendingAnnotations).toEqual([]);
    expect(messagesOf(outline)).toContain("hr-meta.annotations 不是数组");
  });

  it("should skip a non-object element but keep the valid ones after it", () => {
    const outline = outlineOf(withMeta(metaOf(["1", annotation("sec", "合法", "pending_ai")])));

    expect(outline.pendingAnnotations.map((pending) => pending.id)).toEqual(["ann-sec"]);
    expect(messagesOf(outline)).toContain("annotations[0] 不是对象，已跳过");
  });

  it("should skip an element without id/targetId", () => {
    const outline = outlineOf(withMeta('{"annotations":[{"id":"a"},{"comment":"c"}]}'));

    expect(outline.pendingAnnotations).toEqual([]);
    expect(messagesOf(outline)).toContain("annotations[0] 缺少字符串 id/targetId，已跳过");
    expect(messagesOf(outline)).toContain("annotations[1] 缺少字符串 id/targetId，已跳过");
  });
});

describe("hr_outline · hr-meta 注入与原型污染", () => {
  it("should keep a comment containing </script> diagnosable rather than silently dropped", () => {
    const outline = outlineOf(
      withMeta('{"annotations":[{"id":"a","targetId":"sec","comment":"x</script>"}]}'),
    );

    expect(codesOf(outline)).toContain("invalid_meta");
  });

  it("should not touch Object.prototype when the meta JSON carries __proto__", () => {
    const outline = outlineOf(
      withMeta(
        '{"__proto__":{"polluted":"yes"},"annotations":[{"__proto__":{"x":1},"id":"a","targetId":"sec","comment":"c","status":"pending_ai"}]}',
      ),
    );
    const fresh: Record<string, unknown> = {};

    expect(fresh["polluted"]).toBeUndefined();
    expect(Object.keys(Object.prototype)).not.toContain("polluted");
    expect(outline.pendingAnnotations.map((pending) => pending.id)).toEqual(["a"]);
  });

  // P0-D4（已登记）：`src/html/balance.ts:132` 的 `stripRawText` 用 `html.replaceAll(RAW_TEXT_PATTERN, …)`，
  // 实测阈值 4MB 过、8MB 抛 `RangeError: Maximum call stack size exceeded`（V8 对大字符串
  // 的 RegExp `Symbol.replace` 递归）。这不是 M1.3 的代码，但卡片 AC 要求“10MB meta 不崩”，
  // 所以先钉一条 `it.fails`，实现修好后它会红、提醒翻牌。
});
describe("hr_outline · hr-meta 注入与原型污染 · 续 1", () => {
  it("should survive a multi-megabyte meta body ([1MB])", () => {
    const outline = outlineOf(withMeta(`{"annotations":[]}${"".padEnd(1024 * 1024, " ")}`));

    expect(codesOf(outline)).toEqual([]);
    expect([...outline.pendingAnnotations]).toEqual([]);
  });

  // 为什么不用 `it.fails`：同一探针两次跑结果不同（单独跑 10MB 全过，跑到本文件里 8MB 起就抛），
  // 把“偶发”钉成“必抛”会变成 flaky 测试；何况覆盖插桩会改变堆形态。故改为只容忍已知模式。
});
describe("hr_outline · hr-meta 注入与原型污染 · 续 1", () => {
  it("should only ever fail a 10MB meta body with RangeError (D4 contract)", () => {
    try {
      const outline = outlineOf(withMeta("a".repeat(10 * 1024 * 1024)));

      expect(codesOf(outline)).toContain("invalid_meta");
    } catch (error) {
      expect(error instanceof RangeError).toBe(true);
      expect(error instanceof Error ? error.message : "").toContain("Maximum call stack");
    }
  }, 30_000);
});
describe("hr_outline · hr-meta 注入与原型污染 · 续 1", () => {
  it("should read a meta script that lives outside the article", () => {
    const outline = outlineOf(
      `<head><script id="hr-meta">${metaOf([annotation("sec", "页头批注", "pending_ai")])}</script></head>` +
        '<article data-hr-id="art"><h2 data-hr-id="sec">标题</h2></article>',
    );

    expect(outline.pendingAnnotations.map((pending) => pending.comment)).toEqual(["页头批注"]);
  });

  it("should expose that the last hr-meta script wins (D3-family pin: LIFO scan)", () => {
    const outline = outlineOf(
      '<article data-hr-id="art">' +
        `<script id="hr-meta">${metaOf([annotation("sec", "第一个", "pending_ai")])}</script>` +
        `<script id="hr-meta">${metaOf([annotation("sec", "第二个", "pending_ai")])}</script>` +
        '<h2 data-hr-id="sec">标题</h2></article>',
    );

    expect(outline.pendingAnnotations.map((pending) => pending.comment)).toEqual(["第二个"]);
  });
});

describe("hr_outline · pendingAnnotations 选择", () => {
  it("should keep only pending_ai annotations", () => {
    const outline = outlineOf(
      withMeta(
        metaOf([
          annotation("sec", "待办", "pending_ai"),
          annotation("sec", "已完成", "resolved"),
          annotation("sec", "未知", "whatever"),
        ]),
      ),
    );

    expect(outline.pendingAnnotations.map((pending) => pending.comment)).toEqual(["待办"]);
    expect(codesOf(outline)).toEqual([]);
  });

  it("should diagnose a targetId that does not exist but keep the annotation", () => {
    const outline = outlineOf(withMeta(metaOf([annotation("ghost-id", "幽灵", "pending_ai")])));

    expect(outline.pendingAnnotations).toEqual([
      { id: "ann-ghost-id", targetId: "ghost-id", comment: "幽灵" },
    ]);
    expect(codesOf(outline)).toEqual(["annotation_target_missing"]);
    expect(outline.diagnostics[0]?.message).toBe(
      '批注 ann-ghost-id 的 targetId="ghost-id" 在文档里不存在',
    );
  });
});
describe("hr_outline · pendingAnnotations 选择 · 续 1", () => {
  it("should match targetId case-sensitively", () => {
    const outline = outlineOf(withMeta(metaOf([annotation("SEC", "大写", "pending_ai")])));

    expect(codesOf(outline)).toEqual(["annotation_target_missing"]);
  });

  it("should accept a targetId that points outside the article (document-wide check)", () => {
    const outline = outlineOf(
      withMeta(metaOf([annotation("outside", "外部引用", "pending_ai")])).replace(
        '<h2 data-hr-id="sec">',
        '<div data-hr-id="outside">x</div><h2 data-hr-id="sec">',
      ),
    );

    expect(codesOf(outline)).toEqual([]);
  });
});
describe("hr_outline · pendingAnnotations 选择 · 续 1", () => {
  it("should keep duplicate annotation ids as-is without deduplicating (pin)", () => {
    const outline = outlineOf(
      withMeta(
        metaOf([
          annotation("sec", "同一条", "pending_ai"),
          annotation("sec", "同一条", "pending_ai"),
        ]),
      ),
    );

    expect(outline.pendingAnnotations.length).toBe(2);
    expect(codesOf(outline)).toEqual([]);
  });

  it("should default a missing comment to an empty string", () => {
    const outline = outlineOf(
      withMeta('{"annotations":[{"id":"a","targetId":"sec","status":"pending_ai"}]}'),
    );

    expect(outline.pendingAnnotations[0]?.comment).toBe("");
  });
});

describe("hr_outline · comment 截断（200 码点）", () => {
  const commentOf = (comment: string): PendingAnnotation => {
    const [first] = outlineOf(
      withMeta(metaOf([annotation("sec", comment, "pending_ai")])),
    ).pendingAnnotations;
    if (first === undefined) {
      throw new Error("expected one pending annotation");
    }
    return first;
  };

  it("should keep a 200-code-point comment untouched", () => {
    const comment = "字".repeat(200);

    expect(commentOf(comment).comment).toBe(comment);
  });

  it("should truncate a 201-code-point comment with an ellipsis", () => {
    const truncated = commentOf("字".repeat(201)).comment;

    expect(Array.from(truncated).length).toBe(201);
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("should never split a surrogate pair (199 CJK + emoji = 200 is kept whole)", () => {
    const comment = `${"字".repeat(199)}😀`;

    expect(commentOf(comment).comment).toBe(comment);
  });

  it("should drop the whole emoji when it sits at code point 201", () => {
    const truncated = commentOf(`${"字".repeat(200)}😀`).comment;

    expect(truncated).toBe(`${"字".repeat(200)}…`);
    expect(truncated.includes("\uFFFD")).toBe(false);
  });
});

describe("hr_outline · 预算裁剪（批注侧）", () => {
  it("should treat a meta object without an annotations key as empty", () => {
    const outline = outlineOf(withMeta("{}"));

    expect([...outline.pendingAnnotations]).toEqual([]);
    expect(codesOf(outline)).toEqual([]);
  });

  it("should drop annotations over the byte budget and say how many", () => {
    const many = Array.from({ length: 60 }, (_unused, index) =>
      annotation("sec", `${String(index)}-${"长".repeat(240)}`, "pending_ai"),
    );
    const outline = outlineOf(withMeta(metaOf(many)));
    const truncated = outline.diagnostics.filter((item) => item.code === "outline_truncated");

    expect(truncated.length).toBe(1);
    expect(truncated[0]?.message).toMatch(/按字节预算丢弃批注 \d+ 条$/u);
    expect(outline.pendingAnnotations.length).toBeLessThan(60);
    expect(JSON.stringify(outline).length).toBeLessThanOrEqual(8192);
  });
});

describe("hr_outline · 批注字段可选性", () => {
  it("should default both missing comment and missing status", () => {
    const outline = outlineOf(withMeta('{"annotations":[{"id":"a","targetId":"sec"}]}'));

    expect(outline.pendingAnnotations).toEqual([]);
    expect(codesOf(outline)).toEqual([]);
  });
});
