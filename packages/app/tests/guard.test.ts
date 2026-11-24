// 这层管：`guard.ts` 的形状守卫——数组排除、批注列表与 diff 响应的合法/非法形状
//（不用 `as`、不用反射）。

import { describe, expect, it } from "vitest";

import {
  isRecord,
  numberTextOf,
  stringOf,
  isAnnotationList,
  isDiffResponse,
} from "../src/guard.ts";

describe("guard · 形状守卫的负例", () => {
  it("should treat an array as not-a-record and reject wrong primitive types", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord({})).toBe(true);
    expect(stringOf(1)).toBeUndefined();
    expect(numberTextOf(true)).toBeUndefined();
    expect(numberTextOf(3)).toBe("3");
  });
});

describe("guard · 批注列表的合法形状", () => {
  it("should accept an annotation envelope and reject everything else", () => {
    const card = { id: "an-1", nodeId: "hr-a", note: "n", status: "pending" as const };

    expect(isAnnotationList({ annotations: [card] })).toBe(true);
    expect(isAnnotationList({ annotations: [], lost: ["an-2"] })).toBe(true);
    // 已解决卡带两个时间/说明字段、失锚卡带 `lost` 字符串、信封带诊断：这些都是**合法**形状，
    // 守卫必须放行——否则服务端多写一个字段，前端就整页拒收。
    expect(
      isAnnotationList({
        annotations: [
          {
            ...card,
            status: "resolved",
            resolvedAt: "2026-01-01T00:00:00.000Z",
            resolutionNote: "已处理",
          },
          { ...card, id: "an-2", lost: "anchor_lost" },
        ],
        diagnostics: ["1 条批注缺 anchor，按整块处理"],
      }),
    ).toBe(true);
    expect(
      isAnnotationList({ annotations: [{ ...card, lost: "orphaned" }], diagnostics: [] }),
    ).toBe(true);
  });
});

describe("guard · 批注列表的非法形状", () => {
  it("should reject an envelope whose fields carry the wrong type", () => {
    const card = { id: "an-1", nodeId: "hr-a", note: "n", status: "pending" as const };

    // 字段给了就要对：`lost` 不是两个枚举值之一、`diagnostics` 不是字符串数组都要拒。
    expect(isAnnotationList({ annotations: [{ ...card, lost: "gone" }] })).toBe(false);
    expect(isAnnotationList({ annotations: [card], diagnostics: [1] })).toBe(false);
    expect(isAnnotationList({ annotations: [{ ...card, status: "done" }] })).toBe(false);
    // 缺 `annotations` / 不是数组 / 根本不是对象：一律 false，绝不能“差不多就放行”。
    expect(isAnnotationList({})).toBe(false);
    expect(isAnnotationList({ annotations: null })).toBe(false);
    expect(isAnnotationList({ annotations: "x" })).toBe(false);
    expect(isAnnotationList([])).toBe(false);
    expect(isAnnotationList(null)).toBe(false);
  });
});

describe("guard · 服务端 diff 的形状守卫", () => {
  it("should accept a diff envelope only when chunks is an array and degraded is boolean", () => {
    expect(
      isDiffResponse({ nodeId: "hr-a", chunks: [{ kind: "ins", text: "x" }], degraded: false }),
    ).toBe(true);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: [], degraded: true })).toBe(true);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: [{ kind: "same", text: "x" }] })).toBe(false);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: [], degraded: "false" })).toBe(false);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: {}, degraded: false })).toBe(false);
    // 缺 `nodeId` 同样不放行：面板靠它标块，没它就只能猜。
    expect(isDiffResponse({ chunks: [], degraded: false })).toBe(false);
    expect(isDiffResponse("nope")).toBe(false);
    // 三档降级都会带原因（一句话，直接显示）：有了就要是字符串，不是字符串仍要拒。
    expect(
      isDiffResponse({ nodeId: "hr-a", chunks: [], degraded: true, degradedReason: "块已重建" }),
    ).toBe(true);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: [], degraded: true, degradedReason: 3 })).toBe(
      false,
    );
  });
});
