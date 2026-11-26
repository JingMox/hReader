import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// 门禁有效性测试：在内存中对虚拟内容+真实 config 跑 lintText，断言违规一定被拦下且 ruleId 精确。
// filePath 必须是属于某个 tsconfig 工程的真实文件（projectService 拒绝浮空路径），
// 这里复用本文件自身：内容仍然只来自内存，磁盘上的本文件保持 lint 干净。
const REPO_ROOT = decodeURIComponent(new URL("../../../", import.meta.url).pathname);
const PROBE_FILE = `${REPO_ROOT}packages/core/tests/gates.test.ts`;
// An app/src path: file scope decides which file-scoped rules (app's Node-globals ban)
// apply to the in-memory source.
const APP_SRC_PROBE_FILE = `${REPO_ROOT}packages/app/src/state.ts`;

interface Probe {
  readonly name: string;
  readonly ruleId: string;
  readonly source: string;
}

const PROBES: readonly Probe[] = [
  {
    name: "any 注释",
    ruleId: "@typescript-eslint/no-explicit-any",
    source:
      "export function bad(value: unknown): number {\n  const loose: any = value;\n  return loose;\n}",
  },
  {
    name: "对象字面量断言",
    ruleId: "@typescript-eslint/consistent-type-assertions",
    source: "export const casted = { a: 1 } as { a: number; b: number };\nconsole.log(casted);",
  },
  {
    name: "ts-ignore 注释",
    ruleId: "@typescript-eslint/ban-ts-comment",
    source: `// @ts-ignore\nexport const implicit: number = "not a number";`,
  },
  {
    name: "无说明的 eslint-disable",
    ruleId: "@eslint-community/eslint-comments/require-description",
    source: `// eslint-disable-next-line no-console\nexport const suppressed = 1;`,
  },
  {
    name: "深层导入",
    ruleId: "no-restricted-imports",
    source: 'import { HrError } from "@hreader/core/src/index";\nexport const probe = HrError;',
  },
  {
    name: "默认导出",
    ruleId: "import/no-default-export",
    source: "export default 1;",
  },
];

const eslint = new ESLint({ cwd: REPO_ROOT });

async function ruleIdsFor(
  source: string,
  filePath: string = PROBE_FILE,
): Promise<string[]> {
  const results = await eslint.lintText(source, { filePath });
  return results.flatMap((result) => result.messages).map((message) => message.ruleId ?? "");
}

describe("lint gate effectiveness", () => {
  it("should stay silent on a clean file (probe is not red for the wrong reason)", async () => {
    expect(await ruleIdsFor("export {};")).toEqual([]);
  }, 120_000);

  it("should not treat a deep-import rejection as covering the package-root boundary", async () => {
    // 盲区取证：@hreader/core → 其他 @hreader/* 包的根导入不受 ESLint 限制，
    // 包边界由 dependency-cruiser 的 core-is-a-foundation 规则守。
    const ruleIds = await ruleIdsFor('import "@hreader/renderer-html";');
    expect(ruleIds).not.toContain("no-restricted-imports");
  }, 120_000);

  it("should report no-restricted-globals for Node globals inside packages/app/src", async () => {
    // packages/app/src is served to the browser verbatim: `process`/`Buffer` must not
    // compile in. The rule is file-scoped, so the probe has to lint at an app/src path.
    const ruleIds = await ruleIdsFor(
      "export const probe = process.env.HOME;",
      APP_SRC_PROBE_FILE,
    );
    expect(ruleIds).toContain("no-restricted-globals");
  }, 120_000);
});

for (const probe of PROBES) {
  describe(`lint gate: ${probe.name}`, () => {
    it(`should report ${probe.ruleId}`, async () => {
      expect(await ruleIdsFor(probe.source)).toContain(probe.ruleId);
    }, 120_000);
  });
}
