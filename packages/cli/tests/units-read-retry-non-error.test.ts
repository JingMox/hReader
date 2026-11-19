// 这层管：`read` 重试链路上的一处**纯防御**分支——重试那一跳抛出的不是 `HrError`。
//
// core 现在只会抛 `HrError`（`readNode` 的每条失败都是 `HrError`），所以这一臂用 mock 强制制造：
// 目的是钉住"报文里不出现 `HrError: ` 这种内部类名，但异常文本不能被吞"。真实现走不到这里。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { HrError } from "@hreader/core";

import { readCommand } from "../src/commands/read";

const calls: string[] = [];

vi.mock("@hreader/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // 第一跳（按选择器）失败 → 第二跳（按 node id）抛出一个非 HrError。
    readNode: (_parsed: unknown, target: string): never => {
      calls.push(target);
      throw target.startsWith("[data-hr-id=")
        ? new TypeError("core 抛了个非 HrError")
        : new HrError("invalid_selector", "这不是合法选择器");
    },
  };
});

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-read-retry-")));
const path = join(dir, "a.html");
writeFileSync(path, '<article data-hr-id="hr-a"><p data-hr-id="hr-b">正文</p></article>', "utf8");
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readCommand · 重试抛出非 HrError", () => {
  it("should keep the foreign error's text and leave its class name out of the message", async () => {
    const failed = await readCommand({
      path,
      target: "hr-x",
      maxBytes: undefined,
      json: false,
    }).then(
      () => {
        throw new Error("期望读取失败，但成功了");
      },
      (error: unknown) => error,
    );

    // 码按目标的字面形态定（没有 `"`/`\`/换行 → node_not_found），不看第二跳抛了什么类型。
    expect(Reflect.get(Object(failed), "code")).toBe("node_not_found");
    const message = String(Reflect.get(Object(failed), "message"));
    // 报文留住外来异常自己的文本与类名（`TypeError: `），但不会冒出我们内部的 `HrError: `。
    expect(message).toContain("core 抛了个非 HrError");
    expect(message).not.toContain("HrError: ");
    // 跳法是内部实现：只要确实按 node id 去读了，顺序不是用户可见物。
    expect(calls).toContain("hr-x");
  });
});
