// 这层管：语义组件的结构规约表（根标签、直接子元素的个数与必备项）；不遍历文档、不产出诊断。

export interface ComponentRule {
  /** `data-hr-component` 的取值，与 `html/constants.ts` 的 `COMPONENT_WHITELIST` 一一对应。 */
  readonly name: string;
  /** 允许的根标签。 */
  readonly roots: readonly string[];
  /** 直接子元素个数的闭区间。 */
  readonly count: readonly [min: number, max: number];
  /** 每组至少要有一个直接子元素命中（组内是“或”，组间是“且”）。 */
  readonly requires: readonly (readonly string[])[];
}

const ANY_COUNT: readonly [number, number] = [0, Number.POSITIVE_INFINITY];

const CALLOUT_ROOTS: readonly string[] = ["aside", "div", "section"];

export const COMPONENT_RULES: readonly ComponentRule[] = [
  { name: "kpi-bento", roots: ["section", "div", "ul"], count: [3, 6], requires: [] },
  { name: "callout-insight", roots: CALLOUT_ROOTS, count: ANY_COUNT, requires: [] },
  { name: "callout-warning", roots: CALLOUT_ROOTS, count: ANY_COUNT, requires: [] },
  { name: "split-compare", roots: ["section", "div"], count: [2, 2], requires: [] },
  { name: "deep-dive", roots: ["details"], count: ANY_COUNT, requires: [["summary"]] },
  { name: "step-timeline", roots: ["ol"], count: ANY_COUNT, requires: [["li"]] },
  { name: "diagram-stage", roots: ["figure"], count: ANY_COUNT, requires: [["figcaption"]] },
  {
    name: "media-card",
    roots: ["figure"],
    count: ANY_COUNT,
    requires: [["audio", "video"], ["figcaption"]],
  },
];

export const componentRuleOf = (name: string): ComponentRule | undefined =>
  COMPONENT_RULES.find((rule) => rule.name === name);
