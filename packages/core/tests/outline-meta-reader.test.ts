// 这层管：阅读器写入的新版批注（`nodeId` / `note` / `pending`）能进 `pendingAnnotations`，旧版 meta 照常可读。

import { describe, expect, it } from "vitest";

import { buildOutline, parseHtml } from "../src/index";
import type { Outline, PendingAnnotation } from "../src/index";

const withMeta = (metaText: string): string =>
  `<article data-hr-id="art"><script id="hr-meta">${metaText}</script>` +
  '<h2 data-hr-id="sec">标题</h2><p>正文</p></article>';

const outlineOf = (html: string): Outline => buildOutline(parseHtml(html));

const metaOf = (annotations: readonly string[]): string =>
  `{"annotations":[${annotations.join(",")}]}`;

const legacyAnnotation = (targetId: string, comment: string): string =>
  JSON.stringify({ id: `ann-${targetId}`, targetId, comment, status: "pending_ai" });

const readerAnnotation = (nodeId: string, note: string, status: string): string =>
  JSON.stringify({
    id: `an-${nodeId}`,
    nodeId,
    anchor: { exact: "正文", prefix: "", suffix: "", start: 0 },
    note,
    status,
    createdAt: "2026-11-21T00:00:00.000Z",
  });

describe("hr_outline · 阅读器写入的新版批注", () => {
  it("should surface a reader-written pending annotation to the agent", () => {
    const outline = outlineOf(withMeta(metaOf([readerAnnotation("sec", "补一个例子", "pending")])));

    expect(outline.pendingAnnotations).toEqual<PendingAnnotation[]>([
      { id: "an-sec", targetId: "sec", comment: "补一个例子" },
    ]);
    expect(outline.diagnostics).toEqual([]);
  });

  it("should skip a reader-written resolved annotation", () => {
    const outline = outlineOf(withMeta(metaOf([readerAnnotation("sec", "已处理", "resolved")])));

    expect(outline.pendingAnnotations).toEqual([]);
  });
});

describe("hr_outline · 新旧两套字段共存", () => {
  it("should keep reading legacy pending_ai annotations alongside new ones", () => {
    const outline = outlineOf(
      withMeta(
        metaOf([legacyAnnotation("sec", "旧版"), readerAnnotation("art", "新版", "pending")]),
      ),
    );

    expect(outline.pendingAnnotations.map((item) => item.comment)).toEqual(["旧版", "新版"]);
  });

  it("should prefer legacy targetId/comment when both field sets are present", () => {
    const both = JSON.stringify({
      id: "an-both",
      targetId: "sec",
      nodeId: "art",
      comment: "旧字段",
      note: "新字段",
      status: "pending",
    });
    const outline = outlineOf(withMeta(metaOf([both])));

    expect(outline.pendingAnnotations).toEqual<PendingAnnotation[]>([
      { id: "an-both", targetId: "sec", comment: "旧字段" },
    ]);
  });
});
