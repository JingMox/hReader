// 这层管：`hr-meta` 顶层字段表——用正典样本 `tests/fixtures/hr-meta-canonical.json` 锁住“真实文档零无效诊断”；
// 不测批注状态过滤与排序（见 read-node.test.ts）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseHtml, readNode } from "../src/index";

/**
 * 正典 `hr-meta` 载荷：`version` / `style` / `annotations` 三字段齐全。
 * 教训：禁止简化成 `{"annotations":[]}`——那会把“每份真实文档多 2 条 warning”锁成正确行为。
 */
const CANONICAL_META = readFileSync(
  fileURLToPath(new URL("fixtures/hr-meta-canonical.json", import.meta.url)),
  "utf8",
);

const docWith = (payload: string): string =>
  '<article data-hr-id="post"><script id="hr-meta" type="application/json">' +
  `${payload}</script><p data-hr-id="p-problem-1">正文</p></article>`;

const readAt = (payload: string, target: string): ReturnType<typeof readNode> =>
  readNode(parseHtml(docWith(payload)), target);

const codesOf = (payload: string): readonly string[] =>
  readAt(payload, "article").diagnostics.map((diagnostic) => diagnostic.code);

describe("meta · the canonical hr-meta payload", () => {
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
