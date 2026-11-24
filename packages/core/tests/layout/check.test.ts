// 这层管：`checkLayout` 的判定面（组件根标签 / 子元素个数 / 必备子元素 / 内联 style）与 path 口径、上限。

import { describe, expect, it } from "vitest";

import { parseHtml } from "../../src/html/parse";
import { checkLayout, LAYOUT_ISSUE_LIMIT } from "../../src/layout/check";
import { parseFragment } from "../../src/ops";

const issuesOf = (article: string): readonly { code: string; message: string }[] =>
  checkLayout(parseHtml(`<article data-hr-id="root">${article}</article>`).root).map(
    ({ code, message }) => ({ code, message }),
  );

const CLEAN = [
  '<div data-hr-component="kpi-bento"><div>1</div><div>2</div><div>3</div></div>',
  '<aside data-hr-component="callout-insight"><p>判断</p></aside>',
  '<aside data-hr-component="callout-warning"><p>代价</p></aside>',
  '<section data-hr-component="split-compare"><div>A</div><div>B</div></section>',
  '<details data-hr-component="deep-dive"><summary>展开</summary><p>细节</p></details>',
  '<ol data-hr-component="step-timeline"><li>一</li><li>二</li></ol>',
  '<figure data-hr-component="diagram-stage"><img src="a.svg" alt="图"><figcaption>图 1</figcaption></figure>',
  '<figure data-hr-component="media-card"><audio controls src="a.m4a"></audio><figcaption>录音</figcaption></figure>',
].join("");

describe("checkLayout · 合规文档", () => {
  it("should report nothing when every component follows its rule", () => {
    expect(issuesOf(CLEAN)).toEqual([]);
  });

  it("should stay silent on an unknown component (the parse layer owns invalid_component)", () => {
    expect(issuesOf('<div data-hr-component="bento-grid"><p>x</p></div>')).toEqual([]);
  });

  it("should return nothing when the root is neither a document nor an element", () => {
    expect(checkLayout({ kind: "text", value: "纯文本" })).toEqual([]);
  });
});

describe("checkLayout · 组件结构", () => {
  it("should flag a component on the wrong root tag", () => {
    expect(issuesOf('<ul data-hr-component="step-timeline"><li>一</li></ul>')).toEqual([
      { code: "component_root", message: "组件 step-timeline 的根应是 <ol>，现在是 <ul>" },
    ]);
  });

  it("should list every allowed root when there are several", () => {
    const [issue] = issuesOf('<p data-hr-component="callout-insight">x</p>');

    expect(issue?.message).toBe(
      "组件 callout-insight 的根应是 <aside> 或 <div> 或 <section>，现在是 <p>",
    );
  });

  it("should flag a kpi-bento outside 3–6 cells and name the node id", () => {
    const html =
      '<div data-hr-component="kpi-bento" data-hr-id="kpi"><div>1</div> <div>2</div></div>';

    expect(issuesOf(html)).toEqual([
      {
        code: "component_shape",
        message: '组件 kpi-bento 的直接子元素应为 3–6 个，<div data-hr-id="kpi"> 里有 2 个',
      },
    ]);
  });

  it("should word an exact count for split-compare", () => {
    const html =
      '<div data-hr-component="split-compare"><div>A</div><div>B</div><div>C</div></div>';

    expect(issuesOf(html)).toEqual([
      {
        code: "component_shape",
        message: "组件 split-compare 的直接子元素应为恰好 2 个，<div> 里有 3 个",
      },
    ]);
  });
});

describe("checkLayout · 必备子元素", () => {
  it("should flag a missing required child", () => {
    expect(issuesOf('<details data-hr-component="deep-dive"><p>细节</p></details>')).toEqual([
      { code: "component_shape", message: "组件 deep-dive 缺少直接子元素 <summary>：<details>" },
    ]);
  });

  it("should report each unmet group of a media-card separately", () => {
    expect(issuesOf('<figure data-hr-component="media-card"><p>x</p></figure>')).toEqual([
      {
        code: "component_shape",
        message: "组件 media-card 缺少直接子元素 <audio> 或 <video>：<figure>",
      },
      { code: "component_shape", message: "组件 media-card 缺少直接子元素 <figcaption>：<figure>" },
    ]);
  });

  it("should accept a video as the media of a media-card", () => {
    const html =
      '<figure data-hr-component="media-card"><video src="a.mp4"></video><figcaption>演示</figcaption></figure>';

    expect(issuesOf(html)).toEqual([]);
  });
});

describe("checkLayout · 内联 style", () => {
  it("should flag an inline style with warning severity and the node path", () => {
    const parsed = parseHtml('<article data-hr-id="root"><p style="color:red">红字</p></article>');

    expect(checkLayout(parsed.root)).toEqual([
      {
        code: "inline_style",
        severity: "warning",
        message: "<p> 带内联 style：长相交给主题，请删掉 style 属性",
        path: "html[0]>body[1]>article[0]>p[0]",
      },
    ]);
  });

  it("should report the style issue before the component issue of the same node", () => {
    const html = '<div data-hr-component="split-compare" style="gap:0"><div>A</div></div>';

    expect(issuesOf(html).map((issue) => issue.code)).toEqual(["inline_style", "component_shape"]);
  });

  it("should keep document order across siblings", () => {
    const html = '<p style="a:b" data-hr-id="first">1</p><p style="a:b" data-hr-id="second">2</p>';

    expect(
      issuesOf(html).map((issue) => /data-hr-id="([a-z]+)"/u.exec(issue.message)?.[1]),
    ).toEqual(["first", "second"]);
  });

  it("should not look inside inline svg but still check the svg element itself", () => {
    const html =
      '<figure data-hr-component="diagram-stage"><svg style="max-width:100%"><g style="fill:red"></g></svg><figcaption>图</figcaption></figure>';

    expect(issuesOf(html)).toEqual([
      { code: "inline_style", message: "<svg> 带内联 style：长相交给主题，请删掉 style 属性" },
    ]);
  });
});

describe("checkLayout · 片段根与上限", () => {
  it("should label a fragment root as <tag>[0]", () => {
    const root = parseFragment('<p style="color:red">红字</p>');

    expect(checkLayout(root).map((issue) => issue.path)).toEqual(["p[0]"]);
  });

  it("should stop at the issue limit", () => {
    const many = '<p style="a:b">x</p>'.repeat(LAYOUT_ISSUE_LIMIT + 5);

    expect(issuesOf(many)).toHaveLength(LAYOUT_ISSUE_LIMIT);
  });

  it("should cap the result even when one node pushes the count past the limit", () => {
    const filler = '<p style="a:b">x</p>'.repeat(LAYOUT_ISSUE_LIMIT - 1);
    const last = '<figure data-hr-component="media-card" style="a:b"></figure>';

    expect(issuesOf(`${filler}${last}`)).toHaveLength(LAYOUT_ISSUE_LIMIT);
  });
});
