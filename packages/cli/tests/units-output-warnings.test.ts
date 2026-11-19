// 这层管：`patch --json`（以及 `dataPatch` 的通用信封）在片段诊断非空时多出的 `warnings` 键。
// F11 起片段解析诊断不再静默丢弃：`duplicate_attribute` 这类"字节里少了一个属性"必须能被机器读到。
//
// 退步时怎么红：无条件带 `warnings`（空列表占位）→ 第二条红；
// 上浮丢了这条诊断（`PatchResult.warnings` 没有传进 `dataPatch`）→ 第一条红。

import { describe, expect, it } from "vitest";

import type { PatchResult } from "@hreader/core";

import { dataPatch } from "../src/output";
import { fieldOf, keysOf, listOf, parseJsonLine } from "./harness";

/** `dataPatch` 只给 payload，行尾的 `\n` 由 `runCli` 那份输出契约负责，这里补齐后复用同一套解析。 */
const decode = (payload: string): unknown => parseJsonLine(`${payload}\n`);

const WARNED: PatchResult = {
  path: "a.html",
  bytes: 42,
  newIds: ["hr-9"],
  replacedIds: [],
  changed: true,
  historyPath: ".hreader/history/a/2026.html",
  undoable: true,
  warnings: [
    {
      code: "duplicate_attribute",
      severity: "warning",
      message: "<p> 上重复的 title 已丢弃前一个",
    },
  ],
};

const CLEAN: PatchResult = { ...WARNED, warnings: [] };

describe("dataPatch · warnings 键只在非空时出现", () => {
  it("should append a warnings key and carry the diagnostic through", () => {
    const parsed = decode(dataPatch(WARNED));

    expect(keysOf(parsed)).toEqual([
      "path",
      "bytes",
      "newIds",
      "changed",
      "historyPath",
      "warnings",
    ]);
    expect(listOf(fieldOf(parsed, "warnings"))).toHaveLength(1);
  });

  it("should not print the key at all when the list is empty", () => {
    expect(keysOf(decode(dataPatch(CLEAN)))).not.toContain("warnings");
    expect(dataPatch(CLEAN)).not.toContain("warnings");
  });
});
