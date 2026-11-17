import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PRINT_CSS, THEMES } from "../src/index";

const entries = Object.entries(THEMES);
const atelier = THEMES["atelier-editorial"];
const diskTheme = readFileSync(
  new URL("../../../styles/atelier-editorial/theme.css", import.meta.url),
  "utf8",
);

describe("THEMES 注册表（§12 裁定 A：只放元数据）", () => {
  it("认得 atelier-editorial，且 id 与键一致", () => {
    expect(atelier?.id).toBe("atelier-editorial");
    expect(entries.every(([key, theme]) => theme.id === key)).toBe(true);
  });

  it("bodyClass 是 visual-<id> 约定，label 非空", () => {
    expect(atelier?.bodyClass).toBe("visual-atelier-editorial");
    expect(atelier?.label.trim()).not.toBe("");
    expect(entries.every(([, theme]) => theme.bodyClass === `visual-${theme.id}`)).toBe(true);
  });

  it("注册表里没有任何 CSS（单一真源是盘上的 theme.css）", () => {
    expect(Object.keys(atelier ?? {}).sort()).toEqual(["bodyClass", "id", "label"]);
    expect(entries.every(([, theme]) => !("css" in theme))).toBe(true);
  });

  // 主题安全闸的负例（`</style>`、`url(http…)`、`@import`）在 core 的 31 例里，打印层不重复实现也不重复测（§13.6）。
  it("盘上的主题里没有 @import（零外部引用的静态部分）", () => {
    expect(diskTheme).not.toContain("@import");
  });

  it("主题的打印块在文件末尾，把暗色变量压成纸面日间值", () => {
    const printAt = diskTheme.lastIndexOf("@media print");
    expect(printAt).toBeGreaterThan(diskTheme.indexOf('data-hr-mode="dark"'));
    expect(diskTheme.slice(printAt)).toContain("--hr-bg: #ffffff;");
  });

  it("盘上的主题 CSS 真实存在且不是骨架样式的副本", () => {
    expect(diskTheme.length).toBeGreaterThan(1024);
    expect(PRINT_CSS).not.toContain(diskTheme.slice(0, 200));
  });
});
