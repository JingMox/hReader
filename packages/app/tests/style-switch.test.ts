// 这层管：0-token 主题切换的四条契约——幂等、失败保留旧 CSS、成功才记录、幂等按已应用 id。

import { describe, expect, it, vi } from "vitest";

import { createStyleSwitch } from "../src/style-switch.ts";

interface Setup {
  readonly loadCss: ReturnType<typeof vi.fn>;
  readonly applied: string[];
  readonly switcher: ReturnType<typeof createStyleSwitch>;
}

const setup = (): Setup => {
  const loadCss = vi.fn((id: string) => Promise.resolve(`/* ${id} */body{color:red}`));
  const applied: string[] = [];
  const applyCss = (css: string): void => {
    applied.push(css);
  };
  return { loadCss, applied, switcher: createStyleSwitch({ loadCss, applyCss }) };
};

/** 长得像 Error、但不是 Error 实例的 rejection：用来打到 `String(error)` 那一支。 */
const notAnError = (): Error => ({ name: "fake", message: "boom" });

describe("createStyleSwitch · 幂等", () => {
  it("should not reload the theme that is already current", async () => {
    const { loadCss, applied, switcher } = setup();
    await expect(switcher.select("manuscript", "manuscript")).resolves.toEqual({
      status: "unchanged",
      id: "manuscript",
    });
    expect(loadCss).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
  });

  it("should report unchanged for a theme it already applied itself", async () => {
    const { loadCss, switcher } = setup();
    await switcher.select("manuscript", "atelier-editorial");
    const second = await switcher.select("manuscript", "other");

    expect(second.status).toBe("unchanged");
    expect(loadCss).toHaveBeenCalledTimes(1);
  });

  it("should end on the same CSS after three switches", async () => {
    const { switcher, applied } = setup();
    await switcher.select("manuscript", "atelier-editorial");
    await switcher.select("atelier-editorial", "manuscript");
    await switcher.select("manuscript", "atelier-editorial");

    expect(applied).toHaveLength(3);
    expect(applied[2]).toBe(applied[0]);
  });
});

describe("createStyleSwitch · 成功路径", () => {
  it("should load and apply a new theme", async () => {
    const { loadCss, applied, switcher } = setup();
    await expect(switcher.select("manuscript", "atelier-editorial")).resolves.toEqual({
      status: "applied",
      id: "manuscript",
    });
    expect(loadCss).toHaveBeenCalledWith("manuscript");
    expect(applied).toEqual(["/* manuscript */body{color:red}"]);
  });
});

describe("createStyleSwitch · 失败路径", () => {
  it("should keep the old CSS when loading fails and not remember the id", async () => {
    const loadCss = vi.fn(() => Promise.reject(new Error("404 no such theme")));
    const applied: string[] = [];
    const switcher = createStyleSwitch({
      loadCss,
      applyCss: (css) => {
        applied.push(css);
      },
    });

    const outcome = await switcher.select("ghost", "atelier-editorial");
    expect(outcome).toEqual({ status: "failed", id: "ghost", message: "404 no such theme" });
    expect(applied).toEqual([]);
    await switcher.select("ghost", "atelier-editorial");
    expect(loadCss).toHaveBeenCalledTimes(2);
  });

  it("should stringify a rejection that is not an Error instance", async () => {
    const switcher = createStyleSwitch({
      loadCss: () => Promise.reject(notAnError()),
      applyCss: vi.fn(),
    });

    await expect(switcher.select("x", "y")).resolves.toEqual({
      status: "failed",
      id: "x",
      message: "[object Object]",
    });
  });
});
