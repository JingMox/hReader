// 这层管：M1.8 CLI 的变异测试（真改 src → 跑指定用例 → 逐字节还原）；不做断言。
//
// 用法：node packages/cli/fixtures/cli-mutants.mjs（从仓库根跑）
// CLI6 是反向变异（把安全/契约逻辑改坏），必须变红。

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("../../..", import.meta.url).pathname;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const MUTANTS = [
  {
    id: "C1",
    name: "jsonOk 少一个换行（单行 JSON 契约破）",
    file: "packages/cli/src/output.ts",
    find: 'export const jsonOk = (data: string): string => `{"ok":true,"data":${data}}\\n`;',
    replace: 'export const jsonOk = (data: string): string => `{"ok":true,"data":${data}}`;',
    tests: ["packages/cli/tests/output.test.ts", "packages/cli/tests/cli-exit-codes.test.ts"],
  },
  {
    id: "C2",
    name: "invalid_utf8 映射错（3 → 1）",
    file: "packages/cli/src/exit-codes.ts",
    find: "  invalid_utf8: EXIT_IO,",
    replace: "  invalid_utf8: EXIT_FAILURE,",
    tests: ["packages/cli/tests/cli-exit-codes.test.ts"],
  },
  {
    id: "C3",
    name: "空 stdin 不再算用法错误（2 → 落进 core）",
    file: "packages/cli/src/run.ts",
    find: '  if (intent.html?.kind === "stdin" && html === "") {',
    replace: "  if (false) {",
    tests: ["packages/cli/tests/cli-exit-codes.test.ts", "packages/cli/tests/cli-io.test.ts"],
  },
  {
    id: "C4",
    name: "严格 UTF-8 解码改成宽容模式",
    file: "packages/cli/src/input.ts",
    find: 'const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });',
    replace: 'const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });',
    tests: ["packages/cli/tests/cli-exit-codes.test.ts", "packages/cli/tests/input.test.ts"],
  },
  {
    id: "C5",
    name: "反向变异：所有 HrError 都报 70（退出码表失效）",
    file: "packages/cli/src/run.ts",
    find: "  return exitCodeOf(error.code);",
    replace: "  return EXIT_INTERNAL;",
    tests: ["packages/cli/tests/cli-exit-codes.test.ts", "packages/cli/tests/input.test.ts"],
  },
  {
    id: "C6",
    name: "反向变异：--json 的失败信封不再写 stdout（只留 stderr）",
    file: "packages/cli/src/run.ts",
    find: "  if (json) io.stdout(jsonError(error.code, error.message));",
    replace: "  if (false) io.stdout(jsonError(error.code, error.message));",
    tests: ["packages/cli/tests/cli-exit-codes.test.ts"],
  },
];

/** Vite 按 mtime/内容缓存转换结果：同秒内改写会被当成旧模块，必须让缓存失效。 */
const pause = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const runVitest = (tests, outputFile) => {
  const result = spawnSync(
    "npx",
    ["vitest", "run", "--reporter=json", `--outputFile=${outputFile}`, ...tests],
    { cwd: ROOT, encoding: "utf8" },
  );
  let report;
  try {
    report = JSON.parse(readFileSync(outputFile, "utf8"));
  } catch {
    throw new Error(
      `vitest 没有产出 JSON（exit ${String(result.status)}）：${String(result.stderr).slice(-800)}`,
    );
  }
  const status = new Map();
  for (const suite of report.testResults ?? []) {
    for (const test of suite.assertionResults ?? []) {
      status.set(test.fullName, test.status === "passed" ? "passed" : "failed");
    }
  }
  return status;
};

const scratch = mkdtempSync(join(tmpdir(), "hr-cli-mutants-"));
const baseline = new Map(
  MUTANTS.map((mutant) => [
    mutant.id,
    runVitest(mutant.tests, join(scratch, `${mutant.id}-base.json`)),
  ]),
);
const restoreFailures = [];

const rows = MUTANTS.map((mutant) => {
  const path = join(ROOT, mutant.file);
  const occurrences = readFileSync(path, "utf8").split(mutant.find).length - 1;
  if (occurrences !== 1)
    return { ...mutant, status: `SKIP（find 命中 ${String(occurrences)} 次）`, killers: [] };
  const original = readFileSync(path);
  try {
    writeFileSync(path, original.toString("utf8").replace(mutant.find, mutant.replace), "utf8");
    const stamp = new Date();
    utimesSync(path, stamp, stamp);
    pause(1100);
    const mutated = runVitest(mutant.tests, join(scratch, `${mutant.id}.json`));
    if (process.env.HR_MUTANT_DEBUG === "1") {
      const base = baseline.get(mutant.id) ?? new Map();
      const failed = [...mutated].filter(([, st]) => st !== "passed").map(([name]) => name);
      process.stdout.write(
        `  [debug] ${mutant.id} base=${String(base.size)} mutated=${String(mutated.size)} failed=${String(failed.length)}\n`,
      );
      for (const name of failed.slice(0, 5))
        process.stdout.write(`    failed: ${name} / inBase=${String(base.has(name))}\n`);
    }
    const killers = [...(baseline.get(mutant.id) ?? new Map())].filter(
      ([fullName, status]) => status === "passed" && mutated.get(fullName) !== "passed",
    );
    return {
      ...mutant,
      status: killers.length > 0 ? `KILLED（${String(killers.length)} 例）` : "SURVIVED",
      killers: killers.map(([fullName]) => fullName),
    };
  } finally {
    writeFileSync(path, original);
    if (sha256(readFileSync(path)) !== sha256(original)) restoreFailures.push(mutant.id);
  }
});

rmSync(scratch, { recursive: true, force: true });

for (const row of rows) {
  process.stdout.write(`${row.id} ${row.status}  ${row.name}  [${row.file}]\n`);
  for (const killer of row.killers.slice(0, 2)) process.stdout.write(`    killed by: ${killer}\n`);
}
writeFileSync(
  join(ROOT, "packages/cli/fixtures/cli-mutants-result.json"),
  `${JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2)}\n`,
);
process.exitCode =
  rows.some((row) => !row.status.startsWith("KILLED")) || restoreFailures.length > 0 ? 1 : 0;
