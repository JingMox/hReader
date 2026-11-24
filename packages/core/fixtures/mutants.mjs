// 这层管：变异测试的"真跑"入口——逐个把 src 里的守卫改成坏实现，跑指定用例，
// 用 baseline 对比出"哪条用例被杀"，然后逐字节还原。不做断言、不改测试。
//
// 用法：node packages/core/fixtures/mutants.mjs（从仓库根跑）
// 退出码：全部被杀且还原成功 = 0；有存活/还原失败 = 1。

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("../../..", import.meta.url).pathname;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const MUTANTS = [
  {
    id: "M1",
    name: "锁重试预算写死（超时不按 timeoutMs 生效）",
    file: "packages/core/src/io/lock.ts",
    find: "    if (deps.clock.now().getTime() >= deadline) {",
    replace: "    if (deps.clock.now().getTime() >= deadline + 60_000) {",
    tests: ["packages/core/tests/io/lock.test.ts"],
  },
  {
    id: "M2",
    name: 'history 用"重新序列化"而不是原字节（CRLF 被折成 LF）',
    file: "packages/core/src/io/patch-file.ts",
    find: "  const historyPath = await writeSnapshot({ dir: historyDir, workspace: target.workspace, data: original }, deps);",
    replace:
      '  const historyPath = await writeSnapshot({ dir: historyDir, workspace: target.workspace, data: encodeUtf8(decodeUtf8(original, target.realPath).replace(/\\r\\n/gu, "\\n")) }, deps);',
    tests: ["packages/core/tests/io/undo-bytes.test.ts"],
  },
  {
    id: "M3",
    name: "原子写不清理遗留 tmp",
    file: "packages/core/src/io/atomic.ts",
    find: "    await removeStaleTmp(deps, dir);\n",
    replace: "\n",
    tests: ["packages/core/tests/io/atomic.test.ts"],
  },
  {
    id: "M4",
    name: "changed:false 仍然写盘 + 留历史",
    file: "packages/core/src/io/patch-file.ts",
    find: "  if (!outcome.changed) {",
    replace: "  if (false) {",
    tests: ["packages/core/tests/io/patch-file.test.ts"],
  },
  {
    id: "M5",
    name: "root replace 用整个元素区间（丢掉 <article> 属性）",
    file: "packages/core/src/ops/patch-node/apply.ts",
    find: "  return isRoot ? { from: span.innerStart, to: span.innerEnd } : { from: span.start, to: span.end };",
    replace: "  return { from: span.start, to: span.end };",
    tests: ["packages/core/tests/io/patch-actions.test.ts"],
  },
  {
    id: "M6",
    name: "反向变异：workspace 包含性检查恒真（逃逸不再被拒）",
    file: "packages/core/src/io/paths.ts",
    find: '  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);',
    replace: "  return true;",
    tests: ["packages/core/tests/io/paths.test.ts"],
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
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      const label = [...(assertion.ancestorTitles ?? []), assertion.title].join(" > ");
      status.set(label, assertion.status === "passed" ? "passed" : "failed");
    }
  }
  if (status.size > 0) return status;
  const walk = (tasks, trail) => {
    for (const task of tasks) {
      const names = trail.length === 0 ? [task.name] : [trail, task.name];
      const label = names.join(" > ");
      if (Array.isArray(task.tasks) && task.tasks.length > 0) walk(task.tasks, label);
      else status.set(label, task.status === "passed" ? "passed" : "failed");
    }
  };
  walk(report.testResults ?? [], "");
  return status;
};

const killersOf = (base, mutated) =>
  [...base]
    .filter(([fullName, status]) => status === "passed" && mutated.get(fullName) !== "passed")
    .map(([fullName]) => fullName);

const scratch = mkdtempSync(join(tmpdir(), "hr-mutants-"));
const baselineOf = (mutant) => runVitest(mutant.tests, join(scratch, `${mutant.id}-baseline.json`));

const baseline = new Map(MUTANTS.map((mutant) => [mutant.id, baselineOf(mutant)]));
const restoreFailures = [];

const applyMutant = (mutant) => {
  const path = join(ROOT, mutant.file);
  const original = readFileSync(path);
  const text = original.toString("utf8");
  try {
    writeFileSync(path, text.replace(mutant.find, mutant.replace), "utf8");
    const mutated = runVitest(mutant.tests, join(scratch, `${mutant.id}.json`));
    const base = baseline.get(mutant.id);
    const killers = killersOf(base, mutated);
    const green = [...base].filter(([, status]) => status === "passed").length;
    if (green === 0) return { status: "UNVERIFIED（baseline 全红，无法归因）", killers };
    return {
      status: killers.length > 0 ? `KILLED（${String(killers.length)} 例）` : "SURVIVED",
      killers,
    };
  } finally {
    writeFileSync(path, original);
    if (sha256(readFileSync(path)) !== sha256(original)) restoreFailures.push(mutant.id);
  }
};

const rows = MUTANTS.map((mutant) => {
  const path = join(ROOT, mutant.file);
  const occurrences = readFileSync(path, "utf8").split(mutant.find).length - 1;
  if (occurrences !== 1) {
    return {
      ...mutant,
      status: `SKIP（find 命中 ${String(occurrences)} 次，src 已变）`,
      killers: [],
    };
  }
  const outcome = applyMutant(mutant);
  return { ...mutant, ...outcome };
});

rmSync(scratch, { recursive: true, force: true });

for (const row of rows) {
  process.stdout.write(`${row.id} ${row.status}  ${row.name}  [${row.file}]\n`);
  for (const killer of row.killers.slice(0, 3)) process.stdout.write(`    killed by: ${killer}\n`);
}
writeFileSync(
  join(ROOT, "packages/core/fixtures/mutants-result.json"),
  `${JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2)}\n`,
);
process.exitCode =
  rows.some((row) => !row.status.startsWith("KILLED")) || restoreFailures.length > 0 ? 1 : 0;
