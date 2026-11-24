// 这层管：`annotations/anchor.ts` 的解析矩阵与 `model.ts` 的 id 稳定性。
// 纯函数直喂结构：每例既断 `status`，也断它带回来的定位信息（start/end 或 reason）。

import { describe, expect, it } from "vitest";

import { resolveAnchor, type AnchorDocument } from "../../src/annotations/anchor";
import { annotationIdOf, type Annotation, type TextAnchor } from "../../src/annotations/model";

const TEXT = ["夜晚的城市", "行人稀少", "夜晚的城市", "灯火通明"].join("\n");

const doc = (text: string, nodeIds: readonly string[] = ["hr-a"]): AnchorDocument => ({
  text,
  nodeIds,
});

const anchorOf = (patch: Partial<TextAnchor> & { readonly exact: string }): TextAnchor => ({
  prefix: "",
  suffix: "",
  start: 0,
  ...patch,
});

const noteOf = (anchor: TextAnchor, nodeId = "hr-a"): Annotation => ({
  id: "an-00000000",
  nodeId,
  anchor,
  note: "",
  status: "pending",
  createdAt: "2024-01-01T00:00:00.000Z",
});

/** 断言成功并给出 [start, end]；失败时把 reason 一并打印，避免"只看到 undefined"。 */
const offsetsOf = (result: ReturnType<typeof resolveAnchor>): [number, number] => {
  if (!result.ok) throw new Error(`预期解析成功，实际 anchor_lost：${result.reason}`);
  return [result.start, result.end];
};

const reasonOf = (result: ReturnType<typeof resolveAnchor>): string =>
  result.ok ? `ok@${String(result.start)}` : result.reason;

describe("resolveAnchor · 命中与消歧", () => {
  it("should resolve a unique occurrence to its exact character range", () => {
    const anchor = anchorOf({ exact: "行人稀少", start: 6 });
    const at = TEXT.indexOf("行人稀少");

    expect(offsetsOf(resolveAnchor(noteOf(anchor), doc(TEXT)))).toEqual([
      at,
      at + "行人稀少".length,
    ]);
  });

  it("should use prefix and suffix to pick one of two identical sentences", () => {
    const second = TEXT.indexOf("夜晚的城市", 1);
    const anchor = anchorOf({
      exact: "夜晚的城市",
      prefix: "\n",
      start: 0,
      suffix: "\n灯火通明",
    });

    expect(offsetsOf(resolveAnchor(noteOf(anchor), doc(TEXT)))).toEqual([
      second,
      second + "夜晚的城市".length,
    ]);
  });

  it("should fall back to the occurrence closest to the recorded start when both fit", () => {
    const second = TEXT.indexOf("夜晚的城市", 1);
    const nearSecond = anchorOf({ exact: "夜晚的城市", start: second });
    const nearFirst = anchorOf({ exact: "夜晚的城市", start: 1 });

    expect(offsetsOf(resolveAnchor(noteOf(nearSecond), doc(TEXT)))).toEqual([second, second + 5]);
    expect(offsetsOf(resolveAnchor(noteOf(nearFirst), doc(TEXT)))).toEqual([0, 5]);
  });
});

describe("resolveAnchor · 自重叠与并列", () => {
  it("should allow self-overlapping matches (aaa / aa has two starts)", () => {
    const overlapping = anchorOf({ exact: "aa", start: 2 });

    expect(offsetsOf(resolveAnchor(noteOf(overlapping), doc("aaa")))).toEqual([1, 3]);
  });
});

describe("resolveAnchor · 位置漂移", () => {
  it("should follow a block that moved instead of reporting a loss", () => {
    const moved = ["灯火通明", "行人稀少", "夜晚的城市"].join("\n");
    const anchor = anchorOf({ exact: "行人稀少", start: 6 });
    const at = moved.indexOf("行人稀少");

    expect(offsetsOf(resolveAnchor(noteOf(anchor), doc(moved)))).toEqual([
      at,
      at + "行人稀少".length,
    ]);
  });
});

describe("resolveAnchor · 失败是返回值", () => {
  it("should report orphaned when the block itself is gone", () => {
    const result = resolveAnchor(noteOf(anchorOf({ exact: "行人稀少" }), "hr-gone"), doc(TEXT));

    expect(reasonOf(result)).toBe("orphaned");
    expect(result.ok).toBe(false);
  });

  it("should adopt a unique hit even when the prefix was edited", () => {
    const anchor = anchorOf({ exact: "行人稀少", prefix: "白天的城市\n" });
    const at = TEXT.indexOf("行人稀少");

    expect(offsetsOf(resolveAnchor(noteOf(anchor), doc(TEXT)))).toEqual([
      at,
      at + "行人稀少".length,
    ]);
  });

  it("should report anchor_lost when the document text was replaced wholesale", () => {
    const replaced = "完全不同的正文，一个字都对不上";

    expect(reasonOf(resolveAnchor(noteOf(anchorOf({ exact: "行人稀少" })), doc(replaced)))).toBe(
      "anchor_lost",
    );
  });

  it("should report anchor_lost for an empty selection instead of matching position 0", () => {
    const result = resolveAnchor(noteOf(anchorOf({ exact: "" })), doc(TEXT));

    expect(reasonOf(result)).toBe("anchor_lost");
    expect(result).not.toHaveProperty("start");
  });

  it("should prefer orphaned over anchor_lost when both conditions hold", () => {
    const result = resolveAnchor(noteOf(anchorOf({ exact: "不存在" }), "hr-gone"), doc(TEXT));

    expect(reasonOf(result)).toBe("orphaned");
  });
});

describe("annotationIdOf · 内容哈希而不是计数器", () => {
  const anchor = anchorOf({ exact: "行人稀少", start: 6 });

  it("should be deterministic for the same input", () => {
    const one = annotationIdOf({ nodeId: "hr-a", anchor, createdAt: "2024-01-01T00:00:00.000Z" });
    const two = annotationIdOf({ nodeId: "hr-a", anchor, createdAt: "2024-01-01T00:00:00.000Z" });

    expect(one).toBe(two);
    expect(one).toMatch(/^an-[0-9a-f]{8}$/u);
  });

  it("should mint two ids for the same position when createdAt differs (nothing gets swallowed)", () => {
    const morning = annotationIdOf({ nodeId: "hr-a", anchor, createdAt: "2024-01-01T08:00:00Z" });
    const evening = annotationIdOf({ nodeId: "hr-a", anchor, createdAt: "2024-01-01T20:00:00Z" });

    expect(morning).not.toBe(evening);
  });

  it("should also separate ids by node and by offset", () => {
    const base = { nodeId: "hr-a", anchor, createdAt: "2024-01-01T00:00:00.000Z" };
    const otherNode = annotationIdOf({ ...base, nodeId: "hr-b" });
    const otherStart = annotationIdOf({ ...base, anchor: { ...anchor, start: 7 } });

    expect(new Set([annotationIdOf(base), otherNode, otherStart]).size).toBe(3);
  });
});

describe("resolveAnchor · 上下文不符", () => {
  it("should adopt a unique hit even when the stored prefix does not fit", () => {
    const result = resolveAnchor(noteOf(anchorOf({ exact: "正文", prefix: "错的前文" })), {
      text: "前文正文后文",
      nodeIds: ["hr-a"],
    });

    expect(result).toEqual({ ok: true, start: 2, end: 4 });
  });

  it("should adopt a unique hit even when the stored suffix does not fit", () => {
    const result = resolveAnchor(noteOf(anchorOf({ exact: "正文", suffix: "错的" })), {
      text: "前文正文后文",
      nodeIds: ["hr-a"],
    });

    expect(result).toEqual({ ok: true, start: 2, end: 4 });
  });

  it("should report ambiguous when every multi-hit candidate fails its context", () => {
    const result = resolveAnchor(noteOf(anchorOf({ exact: "AB", prefix: "X", suffix: "Y" })), {
      text: "ABAB",
      nodeIds: ["hr-a"],
    });

    expect(result).toEqual({ ok: false, reason: "ambiguous" });
  });
});
