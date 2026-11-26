// 这层管：模块级自动起跑 `void main().catch(...)` 的兜底——没有浏览器面时
// catch 自己不许再炸出一个未处理拒绝（乱序下"不装桩的 import"可能抢在装桩用例前）。

import { describe, expect, it, vi } from "vitest";

import { captureUnhandled } from "./support/fake-host.ts";
import { flush } from "./support/main-stubs.ts";

describe("main · 无浏览器面的自动起跑", () => {
  it("should not leak a second rejection from the entry catch when document is absent", async () => {
    const caught = captureUnhandled();
    try {
      // document/window 刻意不装：main() 在 defaultHost() 就拒了，catch 里再造
      // host 曾把"没有 document"再抛一次——那才是真正漏出来的未处理拒绝。
      vi.unstubAllGlobals();
      vi.resetModules();
      await import("../src/main.ts");
      await flush();
      await flush();
      expect(caught.seen).toEqual([]);
    } finally {
      caught.stop();
    }
  });
});
