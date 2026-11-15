// 这层管：`styleDepsOf` 指向的主题根——内置预设的 `theme.css` 必须真的在它下面；
// 以及"资源整个没定位到"时的错归因防线（错误码 + 启动 WARNING）。
// 源码布局下 core 自己算得对，只有打完 bundle / 拷出仓库才会错；`stdio.test.ts` 的真产物用例是主证据，
// 这里把它钉成能直接指出"缺哪个文件"的便宜断言。

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { BUILTIN_STYLES, HrError, loadStyle, nodeStyleDeps } from "@hreader/core";
import { describe, expect, it } from "vitest";

import {
  firstThemeRootOf,
  styleCandidatesOf,
  styleDepsOf,
  styleRootWarningOf,
} from "../src/styleDeps";

/** 一定不存在的一段路径：拿它冒充"产物被拷到仓库外"的布局。 */
const ABSENT_ROOT = join(tmpdir(), "hreader-styles-root-that-is-not-there");

const errorOf = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (caught: unknown) {
    return caught;
  }
};

describe("styleDepsOf", () => {
  it("should point the builtin theme root at a directory that holds every preset's theme.css", () => {
    const { stylesRoot } = styleDepsOf("/workspace");
    // 仓库只发一份主题（`styles/atelier-editorial/theme.css`），三个预设都 `inheritsVisual: "atelier-editorial"`；
    // 主题根指对了，三个 id 的换肤就都成立——错的是那个根，不是缺文件。
    const missing = BUILTIN_STYLES.map((style) => style.inheritsVisual).filter(
      (visualId) => !existsSync(join(stylesRoot, visualId, "theme.css")),
    );

    expect(missing).toEqual([]);
  });
});

describe("styleDepsOf · 整条链", () => {
  it("should load a builtin preset all the way through, not merely find its theme.css", async () => {
    // "文件在"不等于"链通"：这一步真的过 core 的 `loadStyle`（读 theme.css + 命中预设 spec）。
    const { spec } = await loadStyle({ id: "atelier-editorial" }, styleDepsOf("/workspace"));

    expect(spec.id).toBe("atelier-editorial");
    expect(spec.language.persona.length).toBeGreaterThan(0);
  });
});

describe("styleDepsOf · 主题资源缺失", () => {
  it("should refuse with style_io_failure instead of letting core blame the id", () => {
    const caught = errorOf(() => styleDepsOf("/workspace", ABSENT_ROOT));

    // 错归因比报错更贵：风格是存在的，是资源没定位到——所以不能是 `unknown_style`。
    expect(caught instanceof HrError && caught.code).toBe("style_io_failure");
    // 正文只给包内相对位置（绝对路径不该进 content）；绝对的那份在启动 WARNING 里。
    expect(caught instanceof Error ? caught.message : "").toContain(
      "styles/atelier-editorial/theme.css",
    );
    expect(caught instanceof Error ? caught.message : "").not.toContain(ABSENT_ROOT);
  });

  it("should warn once at startup and stay silent when the styles are there", () => {
    expect(styleRootWarningOf("/workspace")).toBeUndefined();
    expect(styleRootWarningOf("/workspace", ABSENT_ROOT)).toContain("WARNING 主题资源缺失：");
  });
});

/** 造一棵"主题资源齐全"的假根：哨兵文件真的存在，`firstThemeRootOf` 才会认它。 */
const themeRootOf = (name: string): string => {
  const root = join(mkdtempSync(join(tmpdir(), `hreader-style-${name}-`)), "styles");
  mkdirSync(join(root, "atelier-editorial"), { recursive: true });
  writeFileSync(join(root, "atelier-editorial", "theme.css"), ":root{}");
  return root;
};

describe("候选顺序", () => {
  it("should put the package-local styles first, with core's repo root as the dev fallback", () => {
    const [first, second] = styleCandidatesOf("/workspace");

    // 包内优先：发布版里包内那份才是真值源（AC-7：把顺序反了，这条必红）。
    // 写精确值而不是 `toContain("packages/mcp-server/styles")`：任何包含该片段的路径（含仓库根那份）都能过子串断言。
    expect(first).toBe(fileURLToPath(new URL("../styles/", import.meta.url)));
    // 仓库根只兜底源码直跑：它由 core 拼，本包不自己写一次深度（AC-3）。
    expect(second).toBe(nodeStyleDeps("/workspace").stylesRoot);
  });

  it("should take the first candidate that really has the theme, so the order is load-bearing", () => {
    const packageLocal = themeRootOf("package");
    const repoRoot = themeRootOf("repo");

    // 这两条锁的是**辅助函数契约**（"取第一个真有主题的候选"），不是生产接线：
    // "包内优先"是否真的接上，由 `install-sim.test.ts` 的哨兵臂黑盒覆盖（往包内那份写哨兵，落盘含哨兵）。
    expect(firstThemeRootOf([packageLocal, repoRoot])).toBe(packageLocal);
    expect(firstThemeRootOf([repoRoot, packageLocal])).toBe(repoRoot);
  });
});
