// Mutation harness for the style engine: applies real edits to src, runs the named test
// cases, then restores byte-for-byte. Makes no assertions itself.
//
// Usage: node packages/core/fixtures/style-mutants.mjs (run from the repo root)
// Exit code: 0 = every mutant killed and every file restored; 1 = a survivor or a failed restore.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("../../..", import.meta.url).pathname;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const MUTANTS = [
  {
    id: "S1",
    name: "applyStyle 的 changed 恒为 true（幂等比较失效 → 重复写盘）",
    file: "packages/core/src/style/apply.ts",
    find: "  return { html: patched, changed: patched !== html, removed: removedOf(anchors, chosen) };",
    replace: "  return { html: patched, changed: true, removed: removedOf(anchors, chosen) };",
    tests: [
      "packages/core/tests/style/apply-file.test.ts",
      "packages/core/tests/style/apply.test.ts",
    ],
  },
  {
    id: "S2",
    name: "样式块用整元素区间替换（丢掉 <style> 开标签与属性）",
    file: "packages/core/src/style/apply.ts",
    find: "    ? splice(chosen.span.innerStart, chosen.span.innerEnd, css)",
    replace: "    ? splice(chosen.span.start, chosen.span.end, css)",
    tests: [
      "packages/core/tests/style/apply.test.ts",
      "packages/core/tests/style/apply-file.test.ts",
    ],
  },
  {
    id: "S3",
    name: "url() 白名单恒真（远程地址不再被拒）",
    file: "packages/core/src/style/css.ts",
    find: '  if (value.startsWith("#") || value.startsWith("data:")) return true;',
    replace: "  return true;",
    tests: [
      "packages/core/tests/style/css-reject.test.ts",
      "packages/core/tests/style/css-allow.test.ts",
    ],
  },
  {
    id: "S4",
    name: "去掉 `<` 扫描（允许 </style> 逃逸）",
    file: "packages/core/src/style/css.ts",
    find: '  { pattern: /</u, reason: "禁止出现 `<`（防止 </style> 逃出样式块）" },\n',
    replace: "",
    tests: [
      "packages/core/tests/style/css-reject.test.ts",
      "packages/core/tests/style/css-allow.test.ts",
    ],
  },
  {
    id: "S5",
    name: "tone 的引用块不再加 `>`（用户文本可自成标题）",
    file: "packages/core/src/style/tone.ts",
    find: "    .map((line) => `> ${line}`.trimEnd())",
    replace: "    .map((line) => line.trimEnd())",
    tests: [
      "packages/core/tests/style/tone-injection.test.ts",
      "packages/core/tests/style/tone-structure.test.ts",
    ],
  },
  {
    id: "S6",
    name: "反向变异：CSS 不再反转义（\\68 ttp 直接放行）",
    file: "packages/core/src/style/css.ts",
    find: "  stripComments(decodeCharEscapes(decodeHexEscapes(css)));",
    replace: "  stripComments(css);",
    tests: [
      "packages/core/tests/style/css-reject.test.ts",
      "packages/core/tests/style/css-allow.test.ts",
    ],
  },
  {
    id: "S7",
    name: "反向变异：未知键只查顶层（嵌套层再也不报）",
    file: "packages/core/src/style/spec.ts",
    find: "      collectUnknown(child, `${at}.${key}`, childSchema, unknown);",
    replace: "      void childSchema;",
    tests: [
      "packages/core/tests/style/spec-reject.test.ts",
      "packages/core/tests/style/spec-parse.test.ts",
    ],
  },
  {
    id: "S8",
    name: "反向变异：禁用词匹配不再折叠大小写（BOOM 逃过 boom）",
    file: "packages/core/src/style/lint.ts",
    find: '    for (const folded of char.normalize("NFKC").toLowerCase()) {',
    replace: '    for (const folded of char.normalize("NFKC")) {',
    tests: [
      "packages/core/tests/style/lint-offset.test.ts",
      "packages/core/tests/style/lint-basic.test.ts",
    ],
  },
];

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
  const walk = (tasks, trail) => {
    for (const task of tasks) {
      const label = [...trail, task.name].join(" > ");
      if (Array.isArray(task.tasks) && task.tasks.length > 0)
        walk(task.tasks, [...trail, task.name]);
      else status.set(label, task.status === "passed" ? "passed" : "failed");
    }
  };
  walk(report.testResults ?? [], []);
  return status;
};

const failedTitlesOf = (tests) => {
  const run = spawnSync("npx", ["vitest", "run", "--reporter=verbose", ...tests], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return [...`${run.stdout}${run.stderr}`.matchAll(/×\s+(.+?)\s+\d+ms/gu)].map((match) =>
    match[1].replace(/\s+/gu, " ").trim(),
  );
};

const killersOf = (base, mutated) =>
  [...base]
    .filter(([fullName, status]) => status === "passed" && mutated.get(fullName) !== "passed")
    .map(([fullName]) => fullName);

const scratch = mkdtempSync(join(tmpdir(), "hr-style-mutants-"));
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
    const mutated = runVitest(mutant.tests, join(scratch, `${mutant.id}.json`));
    const base = baseline.get(mutant.id);
    const killers = killersOf(base, mutated);
    const titles = killers.length > 0 ? failedTitlesOf(mutant.tests) : [];
    return {
      ...mutant,
      status: killers.length > 0 ? `KILLED（${String(killers.length)} 例）` : "SURVIVED",
      killers: titles.length > 0 ? titles : killers,
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
// 运行产物不落工作树（仓库规则：fixtures 只放脚本与静态样本）。
const REPORT_FILE = join(tmpdir(), "hr-style-mutants-result.json");
writeFileSync(
  REPORT_FILE,
  `${JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2)}\n`,
);
process.stdout.write(`report: ${REPORT_FILE}\n`);
process.exitCode =
  rows.some((row) => !row.status.startsWith("KILLED")) || restoreFailures.length > 0 ? 1 : 0;
