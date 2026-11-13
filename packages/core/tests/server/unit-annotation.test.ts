// 这层管：`annotation.ts`——批注按源码区间写回 `<script id="hr-meta">`，只改脚本内部文本。

import { describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import { appendAnnotation, type AnnotationInput } from "../../src/server/annotation";

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

const input = (start: number, end: number, note?: string): AnnotationInput => ({
  start,
  end,
  text: "被批注的原文",
  note,
  status: "open",
});

const codeOfAppend = (html: string, annotation: AnnotationInput): string => {
  try {
    appendAnnotation(html, annotation, "hr-note-x");
    return "no_throw";
  } catch (error: unknown) {
    return error instanceof HrError ? error.code : "no_code";
  }
};

describe("appendAnnotation · 首次写入", () => {
  it("should insert a meta script right before </body> and keep every other byte", () => {
    const [start, end] = absoluteOf(DOC, "正文一");
    const outcome = appendAnnotation(DOC, input(start, end, "改一下"), "hr-note-1");
    const record = { id: "hr-note-1", targetId: "hr-c", comment: "改一下", status: "open" };
    const prefix = DOC.slice(0, DOC.indexOf("</body>"));

    expect(outcome).toEqual({
      html: `${prefix}<script id="hr-meta">${JSON.stringify({ annotations: [record] })}</script></body></html>`,
      newId: "hr-note-1",
      changed: true,
    });
    expect(DOC.startsWith(prefix)).toBe(true);
  });

  it("should fall back to the note text when no note is given", () => {
    const [start, end] = absoluteOf(DOC, "正文一");

    expect(appendAnnotation(DOC, input(start, end), "hr-note-2").html).toContain(
      '"comment":"被批注的原文"',
    );
  });

  it("should target the innermost element covering the range", () => {
    const [start, end] = absoluteOf(DOC, "标题");

    expect(appendAnnotation(DOC, input(start, end), "hr-note-3").html).toContain(
      '"targetId":"hr-b"',
    );
  });

  it("should fall back to root when no element covers the range", () => {
    const start = DOC.indexOf("<!doctype html>");

    expect(appendAnnotation(DOC, input(start, start + 3), "hr-note-4").html).toContain(
      '"targetId":"root"',
    );
  });
});

describe("appendAnnotation · 没有 body 的片段文档", () => {
  it("should append the meta script at the very end", () => {
    const fragment = "<article><p>x</p></article>";
    const outcome = appendAnnotation(fragment, input(0, 5), "hr-note-5");

    expect(outcome.html.startsWith(`${fragment}<script id="hr-meta">`)).toBe(true);
    expect(outcome.html.endsWith("</script>")).toBe(true);
  });
});

describe("appendAnnotation · 已有 meta 时只改内部文本", () => {
  const withMeta = DOC.replace("</body>", `${META}</body>`);

  it("should append the new record and keep the meta tag and neighbors byte-identical", () => {
    const [start, end] = absoluteOf(withMeta, "正文一");
    const outcome = appendAnnotation(withMeta, input(start, end, "新"), "hr-note-1");
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
    const outcome = appendAnnotation(emptyMeta, input(start, end), "hr-note-9");

    expect(outcome.html).toContain('{"annotations":[{"id":"hr-note-9"');
    expect(outcome.html).not.toContain('"hr-note-0"');
  });

  it("should escape </script> inside a note so it cannot close the meta script", () => {
    const [start, end] = absoluteOf(withMeta, "正文一");
    const outcome = appendAnnotation(
      withMeta,
      input(start, end, "</script><script>alert(1)</script>"),
      "hr-note-1",
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
