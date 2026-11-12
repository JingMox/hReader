import { describe, expect, it } from "vitest";

import * as coreEntry from "../../core/src/index";
import { HrError } from "../../core/src/index";

// R1 §3 删掉了 protocol/renderer-html/chrome-extension/app 的占位 `src/index.ts`：
// 仓库当前唯一真实入口是 `@hreader/core`，本文件只守这一个入口。
// 不要在这里 import 其它 @hreader/* 包（depcruise `core-is-a-foundation` 会判错）。
describe("package public surfaces", () => {
  it("should expose exactly HrError from @hreader/core", () => {
    // 类型导出（HrErrorCode）不下沉到运行期；多一个键就是公开面被无意扩大。
    expect(Object.keys(coreEntry).sort()).toEqual(["HrError"]);
    expect(coreEntry.HrError).toBe(HrError);
  });
});

describe("cross-package instanceof", () => {
  it("should recognise an error across two independent entry specifiers", async () => {
    // 第二个 specifier 走不同的解析路径：若包入口被复制成两份类，instanceof 会假。
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
