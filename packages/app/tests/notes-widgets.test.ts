// 这层管：M2.3 的纯 widget/辅助——选区、块文本、右栏卡、diff 规格、闪烁。
// 全是纯函数或注入式接线；真 DOM 交给 fake host 记录调用。
// 写请求与 `coarseDiff` 在 `notes-io.test.ts`。

import { describe, expect, it } from "vitest";

import { changedNodesOf } from "../src/flash.ts";
import { annotationIntentOf } from "../src/wiring.ts";
import type { BlockElementLike, RawSelection, SelectionLike } from "../src/widgets/selection.ts";
import { rawSelectionOf, selectionIntentOf } from "../src/widgets/selection.ts";
import { textOfBlocks } from "../src/widgets/blocks-text.ts";
import { diffSpecsOf, diffStatusOf } from "../src/widgets/diffview.ts";
import { annotationSpecsOf } from "../src/widgets/sidenotes.ts";
import { renderAnnotations, renderDiff } from "../src/wiring.ts";
import { createFakeHost } from "./support/fake-host.ts";

const ROOT = "#hr-root";

const hostOf = () => createFakeHost();
const callsOf = (host: ReturnType<typeof hostOf>, op: string): readonly (readonly unknown[])[] =>
  host.calls.filter((call) => call.op === op).map((call) => call.args);

const selection = (patch: Partial<RawSelection> = {}): RawSelection => ({
  nodeId: "hr-a",
  blockText: "一二三四五六",
  start: 1,
  end: 3,
  crossBlock: false,
  ...patch,
});

describe("selectionIntentOf", () => {
  it("should slice exact and build 32-char context", () => {
    const intent = selectionIntentOf(selection({ blockText: "a".repeat(50), start: 40, end: 45 }));

    expect(intent).toEqual({
      kind: "annotate",
      nodeId: "hr-a",
      anchor: {
        exact: "a".repeat(5),
        prefix: "a".repeat(32),
        suffix: "a".repeat(5),
        start: 40,
      },
    });
  });

  it("should clamp inverted and out-of-range offsets", () => {
    expect(selectionIntentOf(selection({ start: 5, end: 2 })).kind).toBe("empty");
    expect(selectionIntentOf(selection({ start: 99, end: 120 })).kind).toBe("empty");
    expect(selectionIntentOf(selection({ start: -3, end: 2 }))).toMatchObject({
      anchor: { exact: "一二", start: 0 },
    });
  });

  it("should reject whitespace-only and cross-block selections", () => {
    expect(selectionIntentOf(selection({ blockText: "a  b", start: 1, end: 3 })).kind).toBe(
      "empty",
    );
    expect(selectionIntentOf(selection({ crossBlock: true })).kind).toBe("crossBlock");
    expect(annotationIntentOf(selection()).kind).toBe("annotate");
  });
});

interface InnerBlock {
  readonly textContent: string | null;
  readonly getAttribute: (name: string) => string | null;
}

const innerOf = (id: string, text: string | null): InnerBlock => ({
  textContent: text,
  getAttribute: (name: string) => (name === "data-hr-id" ? id : null),
});

const blockOf = (id: string, text: string): BlockElementLike => {
  const inner = innerOf(id, text);
  return { ...inner, closest: () => inner };
};

const bareBlockOf = (text: string | null): BlockElementLike => ({
  ...innerOf("hr-a", text),
  closest: () => innerOf("hr-a", text),
});

interface SelectionOver {
  readonly block?: BlockElementLike | null;
  readonly anchorOffset?: number;
  readonly focusOffset?: number;
  readonly sameFocus?: boolean;
}

const selectionLike = (over: SelectionOver = {}): SelectionLike => {
  const block = over.block === undefined ? blockOf("hr-a", "正文") : over.block;
  const parentElement = block === null ? null : { closest: block.closest };
  const anchorNode = { parentElement };
  return {
    anchorNode,
    anchorOffset: over.anchorOffset ?? 0,
    focusOffset: over.focusOffset ?? 2,
    focusNode: over.sameFocus === false ? { other: true } : anchorNode,
  };
};

describe("rawSelectionOf · 正常路径", () => {
  it("should describe a single-node selection", () => {
    expect(rawSelectionOf(selectionLike())).toEqual({
      nodeId: "hr-a",
      blockText: "正文",
      start: 0,
      end: 2,
      crossBlock: false,
    });
  });

  it("should mark a cross-node selection and fall back to an empty id", () => {
    const raw = rawSelectionOf(selectionLike({ sameFocus: false }));
    const noId = rawSelectionOf(selectionLike({ block: blockOf("", "x") }));

    expect(raw?.crossBlock).toBe(true);
    expect(noId?.nodeId).toBe("");
  });
});

describe("rawSelectionOf · 退化输入", () => {
  it("should return undefined for a null selection", () => {
    expect(rawSelectionOf(null)).toBeUndefined();
  });

  it("should return undefined when anchorNode is null", () => {
    const bare: SelectionLike = {
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
    };

    expect(rawSelectionOf(bare)).toBeUndefined();
  });

  it("should return undefined without a block ancestor", () => {
    expect(rawSelectionOf(selectionLike({ block: null }))).toBeUndefined();
  });

  it("should return undefined when the block has no textContent", () => {
    expect(rawSelectionOf(selectionLike({ block: bareBlockOf(null) }))).toBeUndefined();
  });
});

describe("textOfBlocks", () => {
  it("should strip tags and collapse whitespace", () => {
    const host = createFakeHost(() => new Map([["hr-a", "<p>你好   <em>世界</em></p>"]]));
    const textOf = textOfBlocks(host.host, "<p>你好</p>");

    expect(textOf("hr-a")).toBe("你好 世界");
    expect(textOf("hr-missing")).toBeUndefined();
  });
});

describe("annotationSpecsOf · 分组", () => {
  it("should split pending/resolved and keep input order", () => {
    const specs = annotationSpecsOf([
      { id: "an-1", nodeId: "hr-a", note: "一", status: "pending" },
      { id: "an-2", nodeId: "hr-b", note: "二", status: "resolved", resolvedAt: "t" },
      { id: "an-3", nodeId: "hr-c", note: "三", status: "pending" },
    ]);

    expect(specs.pending.map((spec) => spec.attrs?.["data-hr-annotation"])).toEqual([
      "an-1",
      "an-3",
    ]);
    expect(specs.resolved).toHaveLength(1);
    expect(JSON.stringify(specs.resolved[0])).toContain("已归档 t");
  });

  it("should append the resolution note after the archived timestamp", () => {
    const [card] = annotationSpecsOf([
      {
        id: "an-1",
        nodeId: "hr-a",
        note: "一",
        status: "resolved",
        resolvedAt: "t",
        resolutionNote: "已处理",
      },
    ]).resolved;

    expect(JSON.stringify(card)).toContain("已归档 t：已处理");
  });

  it("should put the note in text, never in html", () => {
    const [card] = annotationSpecsOf([
      { id: "an-1", nodeId: "hr-a", note: "<img onerror=x>", status: "pending" },
    ]).pending;

    expect(JSON.stringify(card)).not.toContain('"html"');
    expect(JSON.stringify(card)).toContain("<img onerror=x>");
  });
});

describe("annotationSpecsOf · 失效标记", () => {
  it("should label both lost reasons and omit the label when not lost", () => {
    const [orphaned] = annotationSpecsOf([
      { id: "an-1", nodeId: "hr-a", note: "x", status: "pending", lost: "orphaned" },
    ]).pending;
    const [lost] = annotationSpecsOf([
      { id: "an-2", nodeId: "hr-a", note: "x", status: "pending", lost: "anchor_lost" },
    ]).pending;
    const [plain] = annotationSpecsOf([
      { id: "an-3", nodeId: "hr-a", note: "x", status: "pending" },
    ]).pending;

    expect(JSON.stringify(orphaned)).toContain("原节点已删除");
    expect(JSON.stringify(lost)).toContain("正文已改写");
    expect(JSON.stringify(plain)).not.toContain("annotation-lost");
    expect(plain?.attrs?.["data-hr-lost"]).toBeUndefined();
  });
});

describe("renderAnnotations / renderDiff", () => {
  it("should write both groups under the sidenote body", () => {
    const host = hostOf();
    renderAnnotations(host.host, ROOT, [
      { id: "an-1", nodeId: "hr-a", note: "x", status: "pending" },
    ]);

    expect(callsOf(host, "children").map((args) => args[0])).toEqual([
      `${ROOT} #hr-notes-pending`,
      `${ROOT} #hr-notes-resolved`,
    ]);
  });

  it("should write chunks and the degraded status", () => {
    const host = hostOf();
    renderDiff(host.host, ROOT, {
      nodeId: "hr-a",
      chunks: [{ kind: "ins", text: "新" }],
      degraded: true,
    });

    expect(callsOf(host, "text")).toEqual([
      [`${ROOT} #hr-diff-status`, "内容较长：已退化为按段落对比"],
    ]);
    const written = callsOf(host, "children").map((args) =>
      typeof args[1] === "string" ? args[1] : "",
    );
    expect(written.join("")).toContain('"tag":"ins"');
  });
});

describe("diffSpecsOf / diffStatusOf", () => {
  it("should map kinds to tags and drop empty chunks", () => {
    const specs = diffSpecsOf({
      nodeId: "hr-a",
      chunks: [
        { kind: "same", text: "同" },
        { kind: "ins", text: "" },
        { kind: "del", text: "旧" },
      ],
      degraded: false,
    });

    expect(specs.map((spec) => spec.tag)).toEqual(["span", "del"]);
    expect(diffStatusOf({ nodeId: "hr-a", chunks: [], degraded: false })).toBe("字符级对比");
  });
});

describe("changedNodesOf", () => {
  it("should parse JSON strings and filter junk", () => {
    expect(changedNodesOf('{"changedNodes":["hr-a","",3,"hr-b"]}')).toEqual(["hr-a", "hr-b"]);
    expect(changedNodesOf({ changedNodes: ["hr-a"] })).toEqual(["hr-a"]);
    expect(changedNodesOf('{"changedNodes":"x"}')).toEqual([]);
    expect(changedNodesOf("[1]")).toEqual([]);
    expect(changedNodesOf("{not json")).toEqual([]);
    expect(changedNodesOf(42)).toEqual([]);
    expect(changedNodesOf(null)).toEqual([]);
  });
});
