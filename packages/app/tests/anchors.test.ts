// 这层测：模板锚点自检（P0-1 的回归保护）——`boot` 挂载后逐条核对 `REQUIRED_ANCHORS`，
// 缺一个就必须**可见地失败**（`#hr-statusbar` + logger），绝不静默跳过。
import { describe, expect, it, vi } from "vitest";

import { boot } from "../src/boot.ts";
import { missingAnchorsOf, reportMissingAnchors, REQUIRED_ANCHORS } from "../src/anchors.ts";
import { flush, harnessOf } from "./support/boot-harness.ts";

const hostWith = (
  probe: (selector: string) => boolean,
): { has: (selector: string) => boolean } => ({
  has: probe,
});

describe("missingAnchorsOf", () => {
  it("should report exactly the selector that is missing", () => {
    const missing = missingAnchorsOf(hostWith((selector) => selector !== "#hr-diff-chunks"));

    expect(missing).toEqual(["#hr-diff-chunks"]);
    expect(REQUIRED_ANCHORS).toContain("#hr-diff-chunks");
  });

  it("should report nothing when the template has every anchor", () => {
    expect(missingAnchorsOf(hostWith(() => true))).toEqual([]);
  });

  it("should skip the check entirely when the host has no `has`", () => {
    expect(missingAnchorsOf({})).toEqual([]);
  });

  it("should treat a throwing probe as unknown instead of missing", () => {
    // 假 host 的选择器引擎可能对某些串抛错（例如非法 CSS）：那不是"模板缺锚点"。
    const missing = missingAnchorsOf(
      hostWith((selector) => {
        if (selector === "#hr-notes-body") throw new Error("bad selector");
        return true;
      }),
    );

    expect(missing).toEqual([]);
  });

  it("should list every missing anchor in table order", () => {
    const missing = missingAnchorsOf(
      hostWith((selector) => selector !== "#hr-diff" && selector !== "#hr-notes-body"),
    );

    expect(missing).toEqual(["#hr-notes-body", "#hr-diff"]);
  });
});

describe("reportMissingAnchors", () => {
  it("should do nothing at all when the template is complete", () => {
    const text = vi.fn();
    const logger = vi.fn();

    reportMissingAnchors({ text }, logger, []);

    expect(text.mock.calls).toEqual([]);
    expect(logger.mock.calls).toEqual([]);
  });

  it("should write the status bar and the log 一次，并对同一组缺失去重", () => {
    const text = vi.fn();
    const logger = vi.fn();

    reportMissingAnchors({ text }, logger, ["#hr-note-submit"]);
    reportMissingAnchors({ text }, logger, ["#hr-note-submit"]);

    expect(text.mock.calls).toEqual([["#hr-statusbar", "UI 模板缺锚点: #hr-note-submit"]]);
    expect(logger.mock.calls).toHaveLength(1);
  });

  it("should report a different missing set separately", () => {
    const text = vi.fn();
    const logger = vi.fn();

    reportMissingAnchors({ text }, logger, ["#hr-note-draft"]);
    reportMissingAnchors({ text }, logger, ["#hr-note-editor"]);

    expect(text.mock.calls).toEqual([
      ["#hr-statusbar", "UI 模板缺锚点: #hr-note-draft"],
      ["#hr-statusbar", "UI 模板缺锚点: #hr-note-editor"],
    ]);
  });
});

describe("boot · 缺锚点时用户看得见", () => {
  it("should put the missing-anchor message in #hr-statusbar from the real boot entry", async () => {
    const h = harnessOf(true);
    const logger = vi.fn();
    const host = { ...h.deps.host, has: (selector: string) => selector !== "#hr-diff-chunks" };

    const booted = boot({ ...h.deps, host, logger });
    await flush();

    const texts = h.fake.calls
      .filter((call) => call.op === "text" && call.args[0] === "#hr-statusbar")
      .map((call) => call.args[1]);
    expect(texts).toEqual(["UI 模板缺锚点: #hr-diff-chunks"]);
    expect(logger.mock.calls).toEqual([["UI 模板缺锚点: #hr-diff-chunks"]]);
    booted.destroy();
  });

  it("should stay silent when the host exposes a complete template", async () => {
    const h = harnessOf(true);
    const logger = vi.fn();
    const host = { ...h.deps.host, has: () => true };

    const booted = boot({ ...h.deps, host, logger });
    await flush();

    expect(
      h.fake.calls.filter((call) => call.op === "text" && call.args[0] === "#hr-statusbar"),
    ).toEqual([]);
    expect(logger.mock.calls).toEqual([]);
    booted.destroy();
  });
});
