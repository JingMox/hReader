import { describe, expect, it } from "vitest";

import * as coreEntry from "../../core/src/index";
import { HrError } from "../../core/src/index";

// M1.1 起 `@hreader/core` 的公开面由 docs/02 §5.2 与卡片定义，M1.1 追加 3 个 HTML 函数。
// 断言策略（为什么这不是放水）：
//   1. 规格成员逐条点名 —— 少一个就红，报错直接指到缺的名字；
//   2. 额外键只允许"规格表里没有"的，且报错信息是"多出了谁" —— 内部符号漏出仍然红。
// M1.0 的 `toEqual(["HrError"])` 是快照式断言：它每张卡都会因合法扩面变红，而红的原因和
// "实现漏了一个函数"长得一模一样。双表把两种失败区分开，判据仍来自规格（REQUIRED 列表）。
const REQUIRED_RUNTIME_EXPORTS = ["HrError", "injectNodeIds", "parseHtml", "serializeHtml"];

describe("package public surfaces", () => {
  it("should expose the four runtime exports the spec declares", () => {
    expect(typeof coreEntry.HrError).toBe("function");
    expect(typeof coreEntry.parseHtml).toBe("function");
    expect(typeof coreEntry.serializeHtml).toBe("function");
    expect(typeof coreEntry.injectNodeIds).toBe("function");
  });

  it("should not leak internal symbols onto the public surface", () => {
    const unexpected = Object.keys(coreEntry).filter(
      (name) => !REQUIRED_RUNTIME_EXPORTS.includes(name),
    );
    expect(unexpected).toEqual([]);
  });

  it("should keep HrError identity across two independent entry specifiers", async () => {
    const secondEntry: typeof coreEntry = await import("../../core/src/./index");
    const error = new secondEntry.HrError("locked", "from second entry");

    expect(secondEntry.HrError).toBe(HrError);
    expect(error).toBeInstanceOf(HrError);
  });

  it("should keep code readable from a consumer that only knows the public entry", () => {
    const error: unknown = new HrError("invalid_selector", "bad selector");

    if (!(error instanceof coreEntry.HrError)) {
      throw new Error("unreachable: core entry class identity must hold");
    }

    expect(error.code).toBe("invalid_selector");
  });
});
