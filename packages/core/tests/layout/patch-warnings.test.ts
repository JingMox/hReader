// 这层管：排版约束在写入时就生效——`applyPatch` 照常落盘，但把片段的排版问题随 warnings 带出来。

import { describe, expect, it } from "vitest";

import { applyPatch } from "../../src/ops";

const DOC = '<article data-hr-id="root"><p data-hr-id="p1">正文</p></article>';

const warningsOf = (html: string): readonly string[] =>
  applyPatch(DOC, { targetId: "p1", action: "insert_after", html }).warnings.map(
    (warning) => `${warning.code}@${warning.path ?? ""}`,
  );

describe("applyPatch · 排版警告", () => {
  it("should surface an inline style in the fragment as a warning and still patch", () => {
    const outcome = applyPatch(DOC, {
      targetId: "p1",
      action: "insert_after",
      html: '<p style="color:red">红字</p>',
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.warnings.map((warning) => warning.code)).toEqual(["inline_style"]);
  });

  it("should locate a nested component problem relative to the fragment root", () => {
    const html = '<section><div data-hr-component="split-compare"><div>A</div></div></section>';

    expect(warningsOf(html)).toEqual(["component_shape@section[0]>div[0]"]);
  });

  it("should add nothing for a fragment that follows the rules", () => {
    expect(warningsOf('<aside data-hr-component="callout-insight"><p>判断</p></aside>')).toEqual(
      [],
    );
  });
});
