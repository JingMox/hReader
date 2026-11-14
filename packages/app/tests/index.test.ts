// 这层管：包的公开面（`src/index.ts`）——导出集合是契约，少一个都算破坏。

import { describe, expect, it } from "vitest";

import * as publicApi from "../src/index.ts";

describe("index · 公共面", () => {
  it("should export exactly the seven paired-side constructors", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "boot",
      "createSse",
      "createStore",
      "createStyleSwitch",
      "initialState",
      "intentOf",
      "reduce",
    ]);
    expect(publicApi.boot).toBeTypeOf("function");
    expect(publicApi.reduce).toBeTypeOf("function");
  });
});
