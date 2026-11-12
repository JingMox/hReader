// 这层管：`hr-meta` 顶层字段表（卡片 v3 #20）——用 `docs/02` 的正典样本锁住“真实文档零无效诊断”；
// 不测批注状态过滤与排序（见 read-node.test.ts）。

import { describe, expect, it } from "vitest";

import { parseHtml, readNode } from "../src/index";

/**
 * 逐字取自 `docs/02-architecture-and-roadmap.md:100-118`。
 * v3 #20 的教训：禁止简化成 `{"annotations":[]}`——那会把“每份真实文档多 2 条 warning”锁成正确行为。
 */
const CANONICAL_META = `{
    "version": "1.0",
    "style": { "visual": "atelier-editorial", "tone": "feynman-tech" },
    "annotations": [
      {
        "id": "ann-01",
        "targetId": "p-problem-1",
        "selectedText": "假设网络发生分区",
        "comment": "这里请用银行跨行转账的例子具象化解释一下脑裂问题",
        "status": "pending_ai",
        "createdAt": "2026-11-12T14:30:00Z"
      }
    ]
  }`;

const docWith = (payload: string): string =>
  '<article data-hr-id="post"><script id="hr-meta" type="application/json">' +
  `${payload}</script><p data-hr-id="p-problem-1">正文</p></article>`;

const readAt = (payload: string, target: string): ReturnType<typeof readNode> =>
  readNode(parseHtml(docWith(payload)), target);

const codesOf = (payload: string): readonly string[] =>
  readAt(payload, "article").diagnostics.map((diagnostic) => diagnostic.code);

describe("meta · the canonical payload from docs/02", () => {
  it("should treat version / style / annotations as known fields", () => {
    expect(codesOf(CANONICAL_META)).not.toContain("invalid_meta");
  });

  it("should still project the annotation carried by the canonical payload", () => {
    const result = readAt(CANONICAL_META, "#p-problem-1");

    expect(result.annotations).toEqual([
      {
        id: "ann-01",
        targetId: "p-problem-1",
        comment: "这里请用银行跨行转账的例子具象化解释一下脑裂问题",
      },
    ]);
  });

  it("should accept version alone and style alone", () => {
    expect(codesOf('{"version":"1.0"}')).not.toContain("invalid_meta");
    expect(codesOf('{"style":{}}')).not.toContain("invalid_meta");
  });

  it("should flag exactly one invalid_meta when a fourth field shows up", () => {
    const payload = CANONICAL_META.replace(
      '"version"',
      '"pending_annotations": [],\n    "version"',
    );
    const result = readAt(payload, "#p-problem-1");
    const invalid = result.diagnostics.filter((diagnostic) => diagnostic.code === "invalid_meta");

    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.message).toBe(
      'hr-meta 含未知字段 "pending_annotations"（只接受 "version" / "style" / "annotations"）',
    );
    expect(result.annotations.map((annotation) => annotation.id)).toEqual(["ann-01"]);
  });
});
