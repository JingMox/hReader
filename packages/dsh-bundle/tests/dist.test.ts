// 这层管：`build` 产出的 `dist/` 能直接装进宿主——自包含（不 import `@hreader/core`）、
// 不带 `workspace:` 协议、声明文件带着 `@deepseek-ai/cordis` 的类型合并。
// 自己建产物再断言（同 `packages/mcp-server/tests/probe.ts`），不依赖外部先 `pnpm build`。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_STYLES } from "@hreader/core";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_DIR = `${PACKAGE_ROOT}dist`;
const DIST_JS = `${DIST_DIR}/index.js`;
const DIST_DTS = `${DIST_DIR}/index.d.ts`;
const DIST_EVENTS_DTS = `${DIST_DIR}/events.d.ts`;

/** `dist/` 下所有文件的相对路径与全文（交付物是**整份 dist**，不只是入口那两个文件）。 */
const distFiles = (): { path: string; text: string }[] =>
  readdirSync(DIST_DIR, { recursive: true, encoding: "utf8" })
    .map((path) => join(DIST_DIR, path))
    .filter((path) => statSync(path).isFile())
    .map((path) => ({ path: path.slice(DIST_DIR.length + 1), text: readFileSync(path, "utf8") }));

/** 一条 `import … from "x"` / `import "x"` 的模块名。 */
const specifiersOf = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s+["']([^"']+)["']/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

/** 按名字取一个导出（动态 import 给的是 `any`，这里一律收成 `unknown` 再断言）。 */
const exportOf = (module: unknown, name: string): unknown => {
  if (typeof module !== "object" || module === null) throw new Error("dist 没有导出命名空间");
  return Object.entries(module).find(([key]) => key === name)?.[1];
};

beforeAll(() => {
  execFileSync("pnpm", ["-C", PACKAGE_ROOT, "build"], { stdio: "pipe" });
}, 180_000);

describe("dist：宿主能直接加载", () => {
  it("产出了 js + 两个 d.ts（events.d.ts 承载模块合并）", () => {
    for (const file of [DIST_JS, DIST_DTS, DIST_EVENTS_DTS]) {
      expect(existsSync(file), file).toBe(true);
    }
  });

  it("`dist/index.js` 里没有 `@hreader/core` 的运行时 import", () => {
    const packed = readFileSync(DIST_JS, "utf8");

    // 装进 profile 的 node_modules 后 workspace 协议解析不了，core 也必须是静态打进去的。
    expect(packed).not.toContain("@hreader/core");
    expect(packed).not.toContain("workspace:*");
    expect(packed).not.toContain('from "@deepseek-ai/cordis"');
  });

  it("能真的 import 出 `apply`（esbuild 把 node 内建的动态 require 修好了）", async () => {
    const loaded: unknown = await import(DIST_JS);

    expect(exportOf(loaded, "apply")).toBeTypeOf("function");
    expect(exportOf(loaded, "inject")).toEqual(["systemPrompt"]);
    expect(exportOf(loaded, "SECTION_ORDER")).toBe(100);
  });

  it('声明文件带 `declare module "@deepseek-ai/cordis"`（否则使用方看不到类型合并）', () => {
    expect(readFileSync(DIST_EVENTS_DTS, "utf8")).toContain('declare module "@deepseek-ai/cordis"');
  });
});

describe("dist：主题 CSS 跟着产物走", () => {
  it("`dist/styles/<visual>/theme.css` 三件内置主题都解析得到", () => {
    // 期望值由 `BUILTIN_STYLES` 推出（不手抄）：目录名是 `inheritsVisual`（`resolveThemePath` 的
    // 口径，见 `packages/core/src/style/resource.ts` 的 `builtinThemeDir`）。前三个预设共享 atelier
    // 一个 visual，deck-noir 独立成目录；build 少掉 `cp -R ../../styles dist/styles` 就红。
    const visualIds = [...new Set(BUILTIN_STYLES.map((style) => style.inheritsVisual))];
    const stylesDir = join(DIST_DIR, "styles");

    // 下界写死字面量：`visualIds` 若被推成空数组，下面的 `for` 空转、`arrayContaining([])` 恒真，
    // 整个用例就退化成只剩 `existsSync(stylesDir)`（删掉 `theme.css` 也照样绿）。
    // 不写 `length > 0`：推导口径一变（多出 visual 或少掉）也要在断言里现形。
    expect(visualIds).toEqual(["atelier-editorial", "deck-noir"]);
    expect(existsSync(stylesDir)).toBe(true);
    expect(readdirSync(stylesDir)).toEqual(expect.arrayContaining(visualIds));
    for (const id of visualIds) {
      expect(existsSync(join(stylesDir, id, "theme.css")), id).toBe(true);
    }
  });
});

describe("dist：交付物里没有装不上/解析不了的包名", () => {
  it("整份 dist（含 `*.js.map`）都不提 `@hreader/core`，也不带 `workspace:*` 协议", () => {
    // 声明文件同样会被使用方的 tsc 读：`dist/events.d.ts` 里一个 `import type … "@hreader/core"`
    // 就足以让装进 profile 的人报 Cannot find module（core 只是 workspace 的 devDep）。
    // `index.js.map` 也算交付物：靠 `--sources-content=false` 做到只留路径、不夹带 core 源码。
    // 断言写 `workspace:*` 而非 `workspace:`：`readonly workspace: string;` 是字段名，不是协议。
    const offenders = distFiles()
      .filter((file) => file.text.includes("@hreader/core") || file.text.includes("workspace:*"))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
    expect(distFiles().map((file) => file.path)).toEqual(
      expect.arrayContaining(["index.js", "index.d.ts", "events.d.ts"]),
    );
  });

  it('声明文件里没有 `from "@deepseek-ai/…"` 的裸依赖（使用方没装就是 TS2307）', () => {
    // `src/events.ts` 有一行 `import type {}` 种子（留给本包自己看增强链用），它必须被擦干净。
    const offenders = distFiles()
      .filter((file) => file.path.endsWith(".d.ts") && /from\s+["']@deepseek-ai\//u.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("`dist/index.d.ts` 里的裸包名只有 `@deepseek-ai/*`（其余一律相对路径或 node 内建）", () => {
    const bare = specifiersOf(readFileSync(DIST_DTS, "utf8")).filter(
      (specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"),
    );

    expect(bare.filter((specifier) => !specifier.startsWith("@deepseek-ai/"))).toEqual([]);
  });
});
