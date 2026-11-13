// 这层管：`discoverStyles` 的坏文件隔离（AC6.6）——坏一个不许毁掉全部，且每条独立成诊断。

import { describe, expect, it } from "vitest";

import { discoverStyles } from "../../src/style/load";
import { codeOfAsync, systemError } from "../io/harness";
import { builtinSeed, HOME, PROJECT_STYLE, STYLE_YAML, styleEnv, USER_STYLE } from "./harness";

const ROOT = `${HOME}/.hreader/styles`;

describe("discoverStyles · 正常发现", () => {
  it("should return project style first, then user styles sorted by directory name", async () => {
    const env = styleEnv({
      ...builtinSeed(),
      [PROJECT_STYLE]: STYLE_YAML("project-one"),
      [USER_STYLE("zeta")]: STYLE_YAML("zeta"),
      [USER_STYLE("alpha")]: STYLE_YAML("alpha"),
    });
    const found = await discoverStyles(env.deps);

    expect(found.styles.map((spec) => spec.id)).toEqual(["project-one", "alpha", "zeta"]);
    expect(found.diagnostics).toEqual([]);
  });

  it("should return empty collections when no style directory exists", async () => {
    const env = styleEnv(builtinSeed());

    expect(await discoverStyles(env.deps)).toEqual({ styles: [], diagnostics: [] });
  });

  it("should skip a user directory that has no style.yaml", async () => {
    const env = styleEnv({
      ...builtinSeed(),
      [`${ROOT}/empty/theme.css`]: ":root{}",
    });

    expect((await discoverStyles(env.deps)).styles).toEqual([]);
  });
});

describe("discoverStyles · 坏文件隔离", () => {
  it("should keep the good styles and report each bad file separately", async () => {
    const env = styleEnv({
      ...builtinSeed(),
      [PROJECT_STYLE]: STYLE_YAML("project-one"),
      [USER_STYLE("broken-yaml")]: "id: [unclosed",
      [USER_STYLE("unknown-key")]: `${STYLE_YAML("unknown-key")}\nrender: x`,
      [USER_STYLE("good")]: STYLE_YAML("good"),
    });
    const found = await discoverStyles(env.deps);

    expect(found.styles.map((spec) => spec.id)).toEqual(["project-one", "good"]);
    expect(found.diagnostics.map((item) => item.path)).toEqual([
      `${ROOT}/broken-yaml/style.yaml`,
      `${ROOT}/unknown-key/style.yaml`,
    ]);
    for (const diagnostic of found.diagnostics) {
      expect(diagnostic.reason.length).toBeGreaterThan(0);
    }
  });

  it("should report a broken project file instead of throwing", async () => {
    const env = styleEnv({ ...builtinSeed(), [PROJECT_STYLE]: "id: 123" });
    const found = await discoverStyles(env.deps);

    expect(found.styles).toEqual([]);
    expect(found.diagnostics).toHaveLength(1);
    expect(found.diagnostics[0]?.reason).toContain("id");
  });
});

describe("discoverStyles · 目录故障", () => {
  it("should map a real readdir failure to style_io_failure", async () => {
    const env = styleEnv(builtinSeed());
    env.fake.fail("readdir", systemError("EACCES"));

    expect(await codeOfAsync(() => discoverStyles(env.deps))).toBe("style_io_failure");
  });

  it("should treat a missing styles root as empty, not as a failure", async () => {
    const env = styleEnv({});
    env.fake.fail("readdir", systemError("ENOENT"));

    expect(await discoverStyles(env.deps)).toEqual({ styles: [], diagnostics: [] });
  });
});
