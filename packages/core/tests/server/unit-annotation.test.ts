// 这层管：`annotation.ts`——批注按源码区间写回 `<script id="hr-meta">`，只改脚本内部文本。

import { describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import { appendAnnotation, type AnnotationInput } from "../../src/server/annotation";

/** 写入时间戳由调用方从注入时钟取；纯函数层只透传，测试里用固定值保证字节级可比。 */
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const DOC = [
  "<!doctype html>",
  "<html><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文一</p></article>',
  "</body></html>",
].join("");

const META =
  '<script id="hr-meta">{"annotations":[{"id":"hr-note-0","targetId":"root","comment":"旧","status":"open"}]}</script>';

const absoluteOf = (html: string, needle: string): [number, number] => {
  const start = html.indexOf(needle);

  expect(start).toBeGreaterThan(-1);
  return [start, start + needle.length];
};

/** 片段文档没有 `data-hr-id`，`recordOf` 会回落到 `root`；`start` 仍是片段内偏移。 */
const recordOf = (id: string, start: number) => ({
  id,
  nodeId: "root",
  anchor: { exact: "被批注的原文", prefix: "", suffix: "", start },
  note: "被批注的原文",
  status: "pending",
  createdAt: CREATED_AT,
});

/** 文档路径的记录形状：块 id 来自 `data-hr-id`，`anchor.start` 是文档内绝对偏移。 */
const docRecordOf = (id: string, start: number, note: string) => ({
  id,
  nodeId: "hr-c",
  anchor: { exact: "被批注的原文", prefix: "", suffix: "", start },
  note,
  status: "pending",
  createdAt: CREATED_AT,
});

const input = (start: number, end: number, note?: string): AnnotationInput => ({
  start,
  end,
  text: "被批注的原文",
  note,
  status: "open",
});

const codeOfAppend = (html: string, annotation: AnnotationInput): string => {
  try {
    appendAnnotation(html, annotation, "hr-note-x", CREATED_AT);
    return "no_throw";
  } catch (error: unknown) {
    return error instanceof HrError ? error.code : "no_code";
  }
};

describe("appendAnnotation · 首次写入", () => {
  it("should insert a meta script at the article's end and keep every other byte", () => {
    const [start, end] = absoluteOf(DOC, "正文一");
    const outcome = appendAnnotation(DOC, input(start, end, "改一下"), "hr-note-1", CREATED_AT);
    const record = docRecordOf("hr-note-1", start, "改一下");
    // 裁定 #17：无 meta 时插在 `<article>` 末尾（其次 body），用解析器 span 定位，不靠字面 `</body>`。
    const at = DOC.indexOf("</article>");

    expect(outcome).toEqual({
      html: `${DOC.slice(0, at)}<script id="hr-meta">${JSON.stringify({ annotations: [record] })}</script>${DOC.slice(at)}`,
      newId: "hr-note-1",
      changed: true,
    });
  });

  it("should fall back to the note text when no note is given", () => {
    const [start, end] = absoluteOf(DOC, "正文一");

    expect(appendAnnotation(DOC, input(start, end), "hr-note-2", CREATED_AT).html).toContain(
      '"note":"被批注的原文"',
    );
  });

  it("should target the innermost element covering the range", () => {
    const [start, end] = absoluteOf(DOC, "标题");

    expect(appendAnnotation(DOC, input(start, end), "hr-note-3", CREATED_AT).html).toContain(
      '"nodeId":"hr-b"',
    );
  });

  it("should fall back to root when no element covers the range", () => {
    const start = DOC.indexOf("<!doctype html>");

    expect(appendAnnotation(DOC, input(start, start + 3), "hr-note-4", CREATED_AT).html).toContain(
      '"nodeId":"root"',
    );
  });
});

describe("appendAnnotation · 没有 body 的片段文档", () => {
  it("should put the meta script at the end of a bare article", () => {
    const fragment = "<article><p>x</p></article>";
    const outcome = appendAnnotation(fragment, input(0, 5), "hr-note-5", CREATED_AT);

    expect(outcome.html).toBe(
      `<article><p>x</p><script id="hr-meta">${JSON.stringify({ annotations: [recordOf("hr-note-5", 0)] })}</script></article>`,
    );
  });

  it("should fall back to the body end when there is no article at all", () => {
    const fragment = "<body><p>x</p></body>";
    const outcome = appendAnnotation(fragment, input(0, 5), "hr-note-6", CREATED_AT);

    // 没有 `<article>` 时锚点是 `<body>` 的 innerEnd，不是整串末尾。
    expect(outcome.html).toBe(
      `<body><p>x</p><script id="hr-meta">${JSON.stringify({ annotations: [recordOf("hr-note-6", 0)] })}</script></body>`,
    );
  });

  it("should append at the very end when neither article nor body has a span", () => {
    // 隐式元素的 span 存在但 innerEnd=0，所以这条只能测到“有隐式 body”的情形；
    // 真正的“无 span”分支在解析层不存在（见报告待裁定：#implicit-span）。
    const outcome = appendAnnotation("纯文本无标签", input(0, 3), "hr-note-7", CREATED_AT);

    expect(outcome.html).toContain('"id":"hr-note-7"');
    // 隐式 body 的 span 宽度为 0，meta 落在正文之后：正文仍完整、meta 在末尾。
    expect(outcome.html.startsWith("纯文本无标签")).toBe(true);
    expect(outcome.html.indexOf('<script id="hr-meta"')).toBeGreaterThan(
      outcome.html.indexOf("纯文本无标签"),
    );
  });
});

describe("appendAnnotation · 已有 meta 时只改内部文本", () => {
  const withMeta = DOC.replace("</body>", `${META}</body>`);

  it("should append the new record and keep the meta tag and neighbors byte-identical", () => {
    const [start, end] = absoluteOf(withMeta, "正文一");
    const outcome = appendAnnotation(withMeta, input(start, end, "新"), "hr-note-1", CREATED_AT);
    const prefix = withMeta.slice(0, withMeta.indexOf(META));

    expect(outcome.html.startsWith(prefix)).toBe(true);
    expect(outcome.html).toContain('{"annotations":[{"id":"hr-note-0"');
    expect(outcome.html).toContain('"id":"hr-note-1"');
    expect(outcome.html.slice(prefix.length).startsWith('<script id="hr-meta">')).toBe(true);
    expect(outcome.html.endsWith("</script></body></html>")).toBe(true);
  });

  it("should treat an empty meta body as no annotations", () => {
    const emptyMeta = withMeta.replace(META, '<script id="hr-meta"></script>');
    const [start, end] = absoluteOf(emptyMeta, "正文一");
    const outcome = appendAnnotation(emptyMeta, input(start, end), "hr-note-9", CREATED_AT);

    expect(outcome.html).toContain('{"annotations":[{"id":"hr-note-9"');
    expect(outcome.html).not.toContain('"hr-note-0"');
  });

  it("should escape </script> inside a note so it cannot close the meta script", () => {
    const [start, end] = absoluteOf(withMeta, "正文一");
    const outcome = appendAnnotation(
      withMeta,
      input(start, end, "</script><script>alert(1)</script>"),
      "hr-note-1",
      CREATED_AT,
    );

    expect(outcome.html).not.toContain("</script><script>alert");
    expect(outcome.html.match(/<script/gu) ?? []).toHaveLength(2);
    expect(outcome.html).toContain("<\\/script>");
  });
});

describe("appendAnnotation · 偏移校验", () => {
  it.each([
    ["start 非整数", 1.5, 3],
    ["start 为负", -1, 3],
    ["end 不大于 start", 3, 3],
    ["end 越界", 0, DOC.length + 1],
  ])("should reject %s as invalid_input", (_label, start, end) => {
    expect(codeOfAppend(DOC, input(start, end))).toBe("invalid_input");
  });

  it("should reject an empty text", () => {
    expect(codeOfAppend(DOC, { ...input(0, 3), text: "" })).toBe("invalid_input");
  });
});

describe("appendAnnotation · 坏 meta 不能静默覆盖", () => {
  it.each([
    ['<script id="hr-meta">not json</script>'],
    ['<script id="hr-meta">[]</script>'],
    ['<script id="hr-meta">{"annotations":{}}</script>'],
  ])("should reject %s with invalid_document", (meta) => {
    const html = DOC.replace("</body>", `${meta}</body>`);
    const [start, end] = absoluteOf(html, "正文一");

    expect(codeOfAppend(html, input(start, end))).toBe("invalid_document");
  });
});
