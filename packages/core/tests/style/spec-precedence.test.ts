// 这层管：加载优先级（显式 > 项目 > 用户 > 内置）与主题定位（自身 theme.css > inherits_visual）。

import { describe, expect, it } from "vitest";

import { loadStyle } from "../../src/style/load";
import { loadThemeCss } from "../../src/style/theme";
import { codeOfAsync, systemError } from "../io/harness";
import {
  builtinSeed,
  HOME,
  PROJECT_STYLE,
  STYLE_YAML,
  STYLES,
  styleEnv,
  THEME_CSS,
  USER_STYLE,
  USER_THEME,
} from "./harness";

const codeWith = async (seed: Record<string, string>, id: string): Promise<string> => {
  const env = styleEnv(seed);
  return codeOfAsync(() => loadStyle({ id }, env.deps));
};

describe("loadStyle · 四级优先级", () => {
  it("should prefer the project file over user and builtin for the same id", async () => {
    const env = styleEnv({
      ...builtinSeed(),
      [PROJECT_STYLE]: STYLE_YAML("atelier-editorial", "项目级"),
      [USER_STYLE("atelier-editorial")]: STYLE_YAML("atelier-editorial", "用户级"),
    });
    const loaded = await loadStyle({ id: "atelier-editorial" }, env.deps);

    expect(loaded.source).toBe("project");
    expect(loaded.spec.description).toBe("项目级");
  });

  it("should prefer the user file over the builtin preset", async () => {
    const env = styleEnv({
      ...builtinSeed(),
      [USER_STYLE("atelier-editorial")]: STYLE_YAML("atelier-editorial", "用户级"),
    });
    const loaded = await loadStyle({ id: "atelier-editorial" }, env.deps);

    expect(loaded.source).toBe("user");
    expect(loaded.spec.description).toBe("用户级");
  });

  it("should fall back to the builtin preset and its repo theme", async () => {
    const env = styleEnv(builtinSeed());
    const loaded = await loadStyle({}, env.deps);

    expect(loaded.source).toBe("builtin");
    expect(loaded.spec.id).toBe("atelier-editorial");
    expect(loaded.themePath).toBe(`${STYLES}/atelier-editorial/theme.css`);
  });
});

describe("loadStyle · 优先级边界", () => {
  it("should ignore a project file that declares a different id", async () => {
    const env = styleEnv({
      ...builtinSeed(),
      [PROJECT_STYLE]: STYLE_YAML("executive-brief"),
    });

    expect((await loadStyle({ id: "atelier-editorial" }, env.deps)).source).toBe("builtin");
    expect((await loadStyle({ id: "executive-brief" }, env.deps)).source).toBe("project");
  });

  it("should reject an invalid id before touching the disk (path escape)", async () => {
    expect(await codeWith(builtinSeed(), "../../etc/passwd")).toBe("invalid_style");
    expect(await codeWith(builtinSeed(), "/abs/style")).toBe("invalid_style");
  });

  it("should report unknown_style when no source has the id", async () => {
    expect(await codeWith(builtinSeed(), "nope-style")).toBe("unknown_style");
  });
});

describe("loadStyle · 显式路径", () => {
  const EXPLICIT = `${HOME}/exports/my-style.yaml`;

  it("should win over every other source", async () => {
    const env = styleEnv({
      ...builtinSeed(),
      [EXPLICIT]: STYLE_YAML("atelier-editorial", "显式"),
      [PROJECT_STYLE]: STYLE_YAML("atelier-editorial", "项目级"),
      [`${HOME}/exports/theme.css`]: THEME_CSS,
    });
    const loaded = await loadStyle({ id: "atelier-editorial", path: EXPLICIT }, env.deps);

    expect(loaded.source).toBe("explicit");
    expect(loaded.spec.description).toBe("显式");
    expect(loaded.themePath).toBe(`${HOME}/exports/theme.css`);
  });

  it("should reject an explicit file whose id disagrees with the requested id", async () => {
    const env = styleEnv(builtinSeed());
    expect(
      await codeOfAsync(() => loadStyle({ id: "feynman-tech", path: EXPLICIT }, env.deps)),
    ).toBe("not_a_file");
    env.fake.state.files.set(EXPLICIT, new TextEncoder().encode(STYLE_YAML("executive-brief")));
    expect(
      await codeOfAsync(() => loadStyle({ id: "feynman-tech", path: EXPLICIT }, env.deps)),
    ).toBe("invalid_style");
  });

  it("should reject a missing explicit path with not_a_file", async () => {
    const env = styleEnv(builtinSeed());
    expect(await codeOfAsync(() => loadStyle({ path: `${HOME}/nope.yaml` }, env.deps))).toBe(
      "not_a_file",
    );
  });
});

describe("loadStyle · 显式路径的故障面", () => {
  it("should reject a user directory whose file declares another id", async () => {
    const env = styleEnv({
      ...builtinSeed(),
      [USER_STYLE("quiet-clerk")]: STYLE_YAML("executive-brief"),
    });

    expect(await codeOfAsync(() => loadStyle({ id: "quiet-clerk" }, env.deps))).toBe(
      "invalid_style",
    );
  });
});

describe("loadThemeCss · 主题定位与静态防线", () => {
  it("should prefer a theme.css next to the style over inherits_visual", async () => {
    const env = styleEnv({
      ...builtinSeed(),
      [USER_STYLE("quiet-clerk")]: STYLE_YAML("quiet-clerk"),
      [USER_THEME("quiet-clerk")]: ":root{--hr-bg:#000}",
    });
    const loaded = await loadStyle({ id: "quiet-clerk" }, env.deps);

    expect(await loadThemeCss("quiet-clerk", env.deps)).toBe(":root{--hr-bg:#000}");
    expect(loaded.themePath).toBe(USER_THEME("quiet-clerk"));
  });

  it("should fall back to the inherited builtin theme", async () => {
    const env = styleEnv({
      ...builtinSeed("body{color:red}"),
      [USER_STYLE("quiet-clerk")]: STYLE_YAML("quiet-clerk"),
    });

    expect(await loadThemeCss("atelier-editorial", env.deps)).toBe("body{color:red}");
  });

  it("should report unknown_style when the inherited theme is absent", async () => {
    const env = styleEnv({ [USER_STYLE("quiet-clerk")]: STYLE_YAML("quiet-clerk") });

    expect(await codeOfAsync(() => loadThemeCss("quiet-clerk", env.deps))).toBe("unknown_style");
  });
});

describe("loadThemeCss · 静态防线与失败映射", () => {
  it("should refuse an unsafe theme before it can reach the HTML", async () => {
    const env = styleEnv(builtinSeed("@import 'x.css';"));

    expect(await codeOfAsync(() => loadThemeCss("atelier-editorial", env.deps))).toBe(
      "invalid_theme",
    );
  });

  it("should map a theme read failure to style_io_failure instead of unknown_style", async () => {
    const env = styleEnv(builtinSeed());
    env.fake.fail(
      "readFile",
      systemError("EIO"),
      (path) => path === `${STYLES}/atelier-editorial/theme.css`,
    );

    expect(await codeOfAsync(() => loadThemeCss("atelier-editorial", env.deps))).toBe(
      "style_io_failure",
    );
  });

  it("should map non-UTF-8 theme bytes to style_io_failure", async () => {
    const env = styleEnv(builtinSeed());
    env.fake.state.files.set(
      `${STYLES}/atelier-editorial/theme.css`,
      new Uint8Array([0xff, 0xfe, 0x00]),
    );

    expect(await codeOfAsync(() => loadThemeCss("atelier-editorial", env.deps))).toBe(
      "style_io_failure",
    );
  });
});
