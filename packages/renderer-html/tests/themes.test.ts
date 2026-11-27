import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PRINT_CSS, THEMES } from "../src/index";

const entries = Object.entries(THEMES);
const atelier = THEMES["atelier-editorial"];
const diskTheme = readFileSync(
  new URL("../../core/themes/atelier-editorial/theme.css", import.meta.url),
  "utf8",
);

describe("THEMES registry (metadata only)", () => {
  it("should recognize atelier-editorial with id equal to its key", () => {
    expect(atelier?.id).toBe("atelier-editorial");
    expect(entries.every(([key, theme]) => theme.id === key)).toBe(true);
  });

  it("should follow the visual-<id> convention for bodyClass and keep a non-empty label", () => {
    expect(atelier?.bodyClass).toBe("visual-atelier-editorial");
    expect(atelier?.label.trim()).not.toBe("");
    expect(entries.every(([, theme]) => theme.bodyClass === `visual-${theme.id}`)).toBe(true);
  });

  it("should hold no CSS in the registry (the on-disk theme.css is the single source of truth)", () => {
    expect(Object.keys(atelier ?? {}).sort()).toEqual(["bodyClass", "id", "label"]);
    expect(entries.every(([, theme]) => !("css" in theme))).toBe(true);
  });

  // The theme-safety negatives (`</style>`, `url(http…)`, `@import`) live in core's 31 cases; the print layer neither re-implements nor re-tests them.
  it("should contain no @import in the on-disk themes (the static part of zero external references)", () => {
    expect(diskTheme).not.toContain("@import");
  });

  it("should keep the print block at the end of each theme file, clamping dark variables to paper daylight values", () => {
    const printAt = diskTheme.lastIndexOf("@media print");
    expect(printAt).toBeGreaterThan(diskTheme.indexOf('data-hr-mode="dark"'));
    expect(diskTheme.slice(printAt)).toContain("--hr-bg: #ffffff;");
  });

  it("should have real on-disk theme CSS that is not a copy of the skeleton styles", () => {
    expect(diskTheme.length).toBeGreaterThan(1024);
    expect(PRINT_CSS).not.toContain(diskTheme.slice(0, 200));
  });
});
