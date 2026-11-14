// P1-4 的最后一环：面板必须能标出"这是哪一块"的 diff。
// 断言落在 `#hr-diff-chunks` 的有序 `NodeSpec` 上：每个 chunk 元素都带 `data-hr-node="<activeId>"`，
// 且所有 chunk 指向同一个块——全篇 diff（或漏传 nodeId）会让这条红。

import { describe, expect, it } from "vitest";

import { flush } from "./support/boot-harness.ts";
import { bootedWith, shiftD, type Booted } from "./support/notes-harness.ts";

interface Spec {
  readonly tag?: unknown;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

const isSpec = (value: unknown): value is Spec => typeof value === "object" && value !== null;

/** 右栏最后一次 `#hr-diff-chunks` 的 spec（假 Host 把它们记成 JSON 字符串）。 */
const diffSpecsOf = (h: Booted): readonly Spec[] => {
  const raw = h.fake.calls
    .filter(
      (call) => call.op === "children" && (call.args[0]?.endsWith("#hr-diff-chunks") ?? false),
    )
    .at(-1)?.args[1];
  if (raw === undefined) throw new Error("没有往 #hr-diff-chunks 写过 spec");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("spec 不是数组");
  return parsed.filter(isSpec);
};

const openDiff = async (h: Booted): Promise<void> => {
  await flush();
  h.keyHandlers[0]?.(shiftD);
  await flush();
};

/** 右栏 "已写入的状态行"：直接取 `#hr-diff-status` 的 text 调用参数。 */
const statusTextsOf = (h: Booted): readonly string[] =>
  h.fake.calls
    .filter((call) => call.op === "text" && (call.args[0]?.endsWith("#hr-diff-status") ?? false))
    .map((call) => call.args[1] ?? "");

describe("diff 面板 · 降级原因", () => {
  it("should show the server's block_reidentified reason verbatim", async () => {
    // 三档里“重识别成功”必须自己声明：用户看到的不能是默认的“内容较长”，
    // 因为那不是真的——块是换了 id，不是超了格子闸。
    const reason = "该块 ID 已随内容变化重建，按位置重新识别";
    const h = bootedWith({ diffReason: reason });
    await openDiff(h);

    expect(h.store.get().diff.reason).toBe(reason);
    expect(statusTextsOf(h)).toContain(reason);
    h.booted.destroy();
  });
});

describe("diff 面板 · 标块（P1-4）", () => {
  it("should mark every diff chunk with the annotation's own block id", async () => {
    const h = bootedWith();
    await openDiff(h);

    // 目标块 id 从"真的服务端卡片"来，不在断言里写死：否则假件一改，这条就成了自我认证。
    const card = h.store.get().annotations[0];
    expect(card?.id).toBe("an-1111aaaa");
    expect(h.fetchDiff).toHaveBeenCalledWith("an-1111aaaa");

    const specs = diffSpecsOf(h);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.map((spec) => spec.attrs?.["data-hr-node"])).toEqual(
      specs.map(() => card?.nodeId),
    );
    expect(h.store.get().diff.nodeId).toBe(card?.nodeId);
    h.booted.destroy();
  });
});
