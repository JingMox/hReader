// 这层管：包清单契约——dsh 靠这几个字段发现并写下这个包（AC-1），外加 D4 的 import 纪律。
// 解析结果的类型是 unknown：只做 `toMatchObject`/`stringMatching` 断言，不走 `as`（本仓禁断言）。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PKG_DIR = fileURLToPath(new URL("../", import.meta.url));
const SRC_DIR = join(PKG_DIR, "src");

/** 精确版本：`1.2.3`、`1.2.3-rc.1` 或 `catalog:`（版本收敛在 pnpm-workspace.yaml 的 catalog 里，
 *  同样是精确版本单一真源）；`^`/`~`/`*`/`latest`/`workspace:*` 都不匹配。 */
const EXACT_VERSION = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|catalog:)$/u;

/** 一条**行首**的 import 语句的模块名是 `@deepseek-ai/*`（跨行也要认得出，注释里的 `import` 不算）。 */
const DEEPSEEK_IMPORT = /^import\s+([\s\S]*?)\s+from\s+["']@deepseek-ai\/[^"']+["']/gmu;

const readText = (path: string): string => readFileSync(path, "utf8");

/** 按路径取一个字段：解析结果是 `unknown`（本仓禁 `as`），断言前先把值收窄。 */
const fieldOf = (root: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((node, key) => {
    if (typeof node !== "object" || node === null) return undefined;
    return Object.entries(node).find(([name]) => name === key)?.[1];
  }, root);

const textOf = (root: unknown, ...path: string[]): string => {
  const value = fieldOf(root, ...path);
  if (typeof value !== "string") throw new Error(`期望字符串字段：${path.join(".")}`);
  return value;
};

const manifest: unknown = JSON.parse(readText(join(PKG_DIR, "package.json")));
const patch: unknown = parse(readText(join(PKG_DIR, "cordis.patch.yml")));

const SRC_FILES = readdirSync(SRC_DIR).filter((file) => file.endsWith(".ts"));

describe("package.json", () => {
  it("名字与 private 对得上（这个包不发布）", () => {
    expect(manifest).toMatchObject({ name: "@hreader/dsh-bundle", private: true });
  });

  it("dsh 靠 bundle.patch 找到 patch 文件，且该路径真的存在", () => {
    expect(manifest).toMatchObject({ dsh: { bundle: { patch: "./cordis.patch.yml" } } });
    expect(existsSync(resolve(PKG_DIR, "cordis.patch.yml"))).toBe(true);
  });

  it("dsh.compatibility.dshReleases 宣了兼容版本（不写会被 dsh 拦）", () => {
    // 期望值独立手写，不从 manifest 反推：它就是一个字面量契约（"0.2.2-rc.1+ 起兼容"）。
    expect(fieldOf(manifest, "dsh", "compatibility", "dshReleases")).toEqual({
      "0.2.2-rc.1+": "compatible",
    });
  });

  it("devDeps 是精确版本（不带 ^ 或 ~）", () => {
    for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-system-prompt", "esbuild"]) {
      expect(textOf(manifest, "devDependencies", name)).toMatch(EXACT_VERSION);
    }
  });

  it("宿主装的是 dist：main/exports/files 都指向构建产物，不再是 `.ts` 源码", () => {
    expect(textOf(manifest, "main")).toBe("./dist/index.js");
    expect(textOf(manifest, "exports", ".", "types")).toBe("./dist/index.d.ts");
    expect(textOf(manifest, "exports", ".", "default")).toBe("./dist/index.js");
    expect(fieldOf(manifest, "files")).toEqual(["dist", "cordis.patch.yml"]);
  });

  it("没有依赖 @hreader/core（它被 esbuild 打进 dist，装进 profile 后没有 workspace 协议）", () => {
    expect(fieldOf(manifest, "dependencies")).toBeUndefined();
    expect(textOf(manifest, "devDependencies", "@hreader/core")).toBe("workspace:*");
  });
});

describe("package.json：外部依赖只有精确版本", () => {
  it("精确版本的正则真的会拒范围写法（否则上一条是空的）", () => {
    for (const ranged of ["^0.2.2-rc.1", "~0.2.2", "*", "latest", "workspace:*"]) {
      expect(ranged).not.toMatch(EXACT_VERSION);
    }
    expect("0.2.2-rc.1").toMatch(EXACT_VERSION);
    expect("4.1.0").toMatch(EXACT_VERSION);
  });
});

describe("cordis.patch.yml", () => {
  it("只有一个 insert，插件名取自 package.json，config 为空对象", () => {
    expect(patch).toEqual([
      { insert: [{ id: "hreader", name: "@hreader/dsh-bundle", config: {} }] },
    ]);
  });
});

describe("import 纪律（D4）：扫荡真的扫到了东西", () => {
  it("扫到的 src 文件非空：目录一改名，下面两条 `违规数为 0` 就会恒绿", () => {
    expect(SRC_FILES).toEqual(expect.arrayContaining(["index.ts", "events.ts"]));
  });
});

describe("import 纪律（D4）", () => {
  it("src 里对 @deepseek-ai/* 只有 import type，没有任何值导入", () => {
    const valueImports = SRC_FILES.flatMap((file) => {
      const text = readText(join(SRC_DIR, file));
      return [...text.matchAll(DEEPSEEK_IMPORT)]
        .filter((match) => !match[1]?.trimStart().startsWith("type "))
        .map((match) => `${file}: ${match[0].replace(/\s+/gu, " ")}`);
    });

    expect(valueImports).toEqual([]);
  });

  it("src 对 @deepseek-ai/* 不取任何类型绑定（`import type {}` 种子会被 tsc 从 d.ts 擦掉）", () => {
    const bound = SRC_FILES.flatMap((file) =>
      [...readText(join(SRC_DIR, file)).matchAll(DEEPSEEK_IMPORT)]
        .filter((match) => !/^import\s+type\s*\{\s*\}/u.test(match[0]))
        .map((match) => `${file}: ${match[0].replace(/\s+/gu, " ")}`),
    );

    expect(bound).toEqual([]);
  });

  it("上一条的正则真的认得出值导入（否则它是空的）", () => {
    expect('import { Context } from "@deepseek-ai/cordis";').toMatch(DEEPSEEK_IMPORT);
    expect('import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";').toMatch(
      DEEPSEEK_IMPORT,
    );
    expect('// 注释里提到 import { X } from "@deepseek-ai/cordis" 不算').not.toMatch(
      DEEPSEEK_IMPORT,
    );
  });

  it("src 不 require，也不从 'cordis' 旧名导入", () => {
    const offenders = SRC_FILES.filter((file) =>
      /require\(|from "cordis"/u.test(readText(join(SRC_DIR, file))),
    );

    expect(offenders).toEqual([]);
  });
});
