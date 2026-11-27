// 这层管：nodeTemplateDeps 的装配形状（真实 fs 端口 + 真 clock/sleep + 注入的 home 根）。
// 只验组合，不验行为——端口的真实行为由 io/node-fs 测试负责。

import { describe, expect, it } from "vitest";

import { nodeTemplateDeps } from "../../src/templates";

describe("nodeTemplateDeps · 默认依赖", () => {
  it("should compose the node fs port, a real clock/sleep and the home root", () => {
    const deps = nodeTemplateDeps();

    expect(Object.keys(deps).sort()).toEqual(["clock", "fs", "home", "sleep"]);
    expect(typeof deps.home).toBe("string");
    expect(deps.home.length).toBeGreaterThan(0);
    expect(typeof deps.fs.readFile).toBe("function");
    expect(deps.clock.now() instanceof Date).toBe(true);
  });
});
