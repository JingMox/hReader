// 这层管：`jsonError` 的 `data` 侧——`invalid_selector` 的机器可读成因（AC9，docs/05:99：
// `reason`/`count`/`candidates`）就是从这里出去的，调用方靠 `data.reason` 分支。
//
// 为什么单独一个文件：`units-output.test.ts` 已顶到 `max-lines`（300）上限，塞不进新用例；
// 该文件只读不改，这里不重复它的任何断言。
//
// 断言钉用户可见物：`--json` 模式下 stdout 的**逐字**形状（键序、`data` 位置、单个换行）。

import { describe, expect, it } from "vitest";

import { jsonError } from "../src/output";

describe("output · JSON 错误信封的 data 键", () => {
  it("should emit data verbatim after message when the error carries machine-readable causes", () => {
    expect(jsonError("invalid_selector", "无法解析：p[", { reason: "syntax" })).toBe(
      '{"ok":false,"code":"invalid_selector","message":"无法解析：p[","data":{"reason":"syntax"}}\n',
    );
  });

  it("should keep the data key out entirely when there is nothing machine-readable to say", () => {
    // `node_not_found` 不带 `data`：多一个空对象会让调用方的 `data.reason` 分支走向"有成因"。
    expect(jsonError("node_not_found", "没有这个节点")).toBe(
      '{"ok":false,"code":"node_not_found","message":"没有这个节点"}\n',
    );
  });
});
