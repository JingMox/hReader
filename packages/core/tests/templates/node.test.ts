// This layer: the shape of nodeTemplateDeps assembly (real fs port + real clock/sleep + injectable home root).
// Only composition is verified, not behavior — the port's real behavior is owned by io/node-fs tests.

import { describe, expect, it } from "vitest";

import { nodeTemplateDeps } from "../../src/templates";

describe("nodeTemplateDeps · default deps", () => {
  it("should compose the node fs port, a real clock/sleep and the home root", () => {
    const deps = nodeTemplateDeps();

    expect(Object.keys(deps).sort()).toEqual(["clock", "fs", "home", "sleep"]);
    expect(typeof deps.home).toBe("string");
    expect(deps.home.length).toBeGreaterThan(0);
    expect(typeof deps.fs.readFile).toBe("function");
    expect(deps.clock.now() instanceof Date).toBe(true);
  });
});
