// 这层管：组件规约表与 `COMPONENT_WHITELIST` 的一一对应（加了取值却忘了写规约，就在这里变红）。

import { describe, expect, it } from "vitest";

import { COMPONENT_WHITELIST } from "../../src/html/constants";
import { COMPONENT_RULES, componentRuleOf } from "../../src/layout/components";

describe("组件规约表", () => {
  it("should cover exactly the whitelisted component names", () => {
    expect(COMPONENT_RULES.map((rule) => rule.name).sort()).toEqual(
      [...COMPONENT_WHITELIST].sort(),
    );
  });

  it("should give every rule at least one root tag and a sane count range", () => {
    const broken = COMPONENT_RULES.filter(
      (rule) => rule.roots.length === 0 || rule.count[0] > rule.count[1],
    );

    expect(broken).toEqual([]);
  });

  it("should look a rule up by name and return undefined for an unknown one", () => {
    expect(componentRuleOf("media-card")?.requires).toEqual([["audio", "video"], ["figcaption"]]);
    expect(componentRuleOf("nope")).toBeUndefined();
  });
});
