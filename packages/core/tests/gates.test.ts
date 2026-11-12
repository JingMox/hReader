import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// 门禁有效性测试：在内存中对虚拟内容+真实 config 跑 lintText，断言违规一定被拦下且 ruleId 精确。
// filePath 必须是属于某个 tsconfig 工程的真实文件（projectService 拒绝浮空路径），
// 这里复用本文件自身：内容仍然只来自内存，磁盘上的本文件保持 lint 干净。
const REPO_ROOT = decodeURIComponent(new URL("../../../", import.meta.url).pathname);
const PROBE_FILE = `${REPO_ROOT}packages/core/tests/gates.test.ts`;

// 拼出被禁的注释词，避免本文件自己触发 no-warning-comments（location: "anywhere"）。
const TS_IGNORE = ["@ts", "ignore"].join("-");
const ESLINT_DISABLE = ["eslint", "disable"].join("-");

const LONG_FUNCTION_SOURCE = [
  "export function longFunction(): number {",
  "  let total = 0;",
  ...Array.from({ length: 45 }, (_, index) => `  total += ${String(index)};`),
  "  return total;",
  "}",
].join("\n");

const COMPLEXITY_SOURCE = [
  "export function classify(value: number): string {",
  ...Array.from(
    { length: 11 },
    (_, index) => `  if (value === ${String(index)}) return "v${String(index)}";`,
  ),
  '  return "other";',
  "}",
].join("\n");

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
    name: "as 断言",
    ruleId: "@typescript-eslint/consistent-type-assertions",
    source: "const raw: unknown = 1;\nexport const casted = raw as number;\nconsole.log(casted);",
  },
  {
    name: "41 行函数",
    ruleId: "max-lines-per-function",
    source: LONG_FUNCTION_SOURCE,
  },
  {
    name: "复杂度 12",
    ruleId: "complexity",
    source: COMPLEXITY_SOURCE,
  },
  {
    name: "ts-ignore 注释",
    ruleId: "@typescript-eslint/ban-ts-comment",
    source: `// ${TS_IGNORE}\nexport const implicit: number = "not a number";`,
  },
  {
    name: "eslint-disable 注释",
    ruleId: "no-warning-comments",
    source: `// ${ESLINT_DISABLE}-next-line\nexport const suppressed = 1;`,
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

async function ruleIdsFor(source: string): Promise<string[]> {
  const results = await eslint.lintText(source, { filePath: PROBE_FILE });
  return results.flatMap((result) => result.messages).map((message) => message.ruleId ?? "");
}

describe("lint gate effectiveness", () => {
  it("should stay silent on a clean file (probe is not red for the wrong reason)", async () => {
    expect(await ruleIdsFor("export {};")).toEqual([]);
  }, 120_000);

  it("should not treat a deep-import rejection as covering the package-root boundary", async () => {
    // 盲区取证：@hreader/core → @hreader/protocol 的根导入不受 ESLint 限制，
    // 包边界由 dependency-cruiser 的 core-is-a-foundation 规则守（见 test-M1.0.md 实验记录）。
    const ruleIds = await ruleIdsFor('import "@hreader/protocol";');
    expect(ruleIds).not.toContain("no-restricted-imports");
  }, 120_000);
});

for (const probe of PROBES) {
  describe(`lint gate: ${probe.name}`, () => {
    it(`should report ${probe.ruleId}`, async () => {
      expect(await ruleIdsFor(probe.source)).toContain(probe.ruleId);
    }, 120_000);
  });
}
