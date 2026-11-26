// Mutation harness for the server: applies real edits to src, runs the named test files,
// then restores byte-for-byte. Makes no assertions itself.
//
// Usage: node packages/core/fixtures/server-mutants.mjs (repo root)
// Exit code: 0 = every mutant killed and every restore identical; 1 = a survivor or a failed restore.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("../../..", import.meta.url).pathname;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const MUTANTS = [
  {
    id: "V1",
    name: "反向变异：cookie 比较改回 `===`（丢定长比较）",
    file: "packages/core/src/server/auth.ts",
    find: "  if (given === undefined) return false;",
    replace: "  if (given === undefined) return false;\n  if (given === expected) return true;",
    tests: [
      "packages/core/tests/server/auth-timing.test.ts",
      "packages/core/tests/server/unit-auth.test.ts",
    ],
  },
  {
    id: "V2",
    name: "Host/Origin 闸门失效",
    file: "packages/core/src/server/server.ts",
    find: '  const hostOk =\n    hostAllowed(headerOf(req, "host"), port, env.allowHosts) &&\n    originAllowed(headerOf(req, "origin"), port);',
    replace: "  void port;\n  const hostOk = true;",
    tests: ["packages/core/tests/server/auth.test.ts"],
  },
  {
    id: "V3",
    name: "Last-Event-ID 未命中不再发 reset",
    file: "packages/core/src/server/hub.ts",
    find: "  if (!lookup.hit) res.write(resetFrameOf(note));",
    replace: "  if (!lookup.hit && Date.now() < 0) res.write(resetFrameOf(note));",
    tests: [
      "packages/core/tests/server/sse.test.ts",
      "packages/core/tests/server/unit-ring-diff.test.ts",
    ],
  },
  {
    id: "V4",
    name: "事件环不按容量裁",
    file: "packages/core/src/server/event-ring.ts",
    find: "      if (events.length === capacity) events.shift();",
    replace: "      if (events.length > capacity + 50) events.shift();",
    tests: [
      "packages/core/tests/server/unit-ring-diff.test.ts",
      "packages/core/tests/server/sse.test.ts",
    ],
  },
  {
    id: "V5",
    name: "请求体不再限 1 MiB",
    file: "packages/core/src/server/http-io.ts",
    find: "      if (size > MAX_BODY_BYTES) {",
    replace: "      if (size > MAX_BODY_BYTES * 100) {",
    tests: [
      "packages/core/tests/server/wire-http.test.ts",
      "packages/core/tests/server/unit-body-routes.test.ts",
    ],
  },
  {
    id: "V6",
    name: "revision 截断到 4 位（碰撞空间 16 bit）",
    file: "packages/core/src/server/revision.ts",
    find: "export const revisionOf = (bytes: Uint8Array): string => sha256Hex(bytes).slice(0, REVISION_CHARS);",
    replace:
      "export const revisionOf = (bytes: Uint8Array): string => sha256Hex(bytes).slice(0, REVISION_CHARS - 12);",
    tests: [
      "packages/core/tests/server/unit-ring-diff.test.ts",
      "packages/core/tests/server/wire-http.test.ts",
    ],
  },
];

const runVitest = (tests, outputFile) => {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--reporter=json",
      `--outputFile=${outputFile}`,
      ...tests,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 900_000 },
  );
  let raw;
  try {
    raw = JSON.parse(readFileSync(outputFile, "utf8"));
  } catch {
    throw new Error(
      `vitest 没有产出 JSON（exit ${String(result.status)}）：${String(result.stderr).slice(-800)}`,
    );
  }
  return raw;
};

/** vitest 的 JSON 报告：`testResults[].assertionResults[]` 才带 `fullName`。 */
const statusOf = (report) => {
  const map = new Map();
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      const fullName = `${String(file.name)} > ${String(assertion.fullName)}`;
      map.set(fullName, assertion.status);
    }
  }
  return map;
};

const killersOf = (base, mutated) =>
  [...base]
    .filter(([name, status]) => status === "passed" && mutated.get(name) !== "passed")
    .map(([name]) => name);

const scratch = mkdtempSync(join(tmpdir(), "hr-server-mutants-"));
const baseline = new Map(
  MUTANTS.map((mutant) => [
    mutant.id,
    statusOf(runVitest(mutant.tests, join(scratch, `${mutant.id}-base.json`))),
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
    const mutated = statusOf(runVitest(mutant.tests, join(scratch, `${mutant.id}.json`)));
    const killers = killersOf(baseline.get(mutant.id), mutated);
    return {
      ...mutant,
      status: killers.length > 0 ? `KILLED（${String(killers.length)} 例）` : "SURVIVED",
      killers,
    };
  } finally {
    writeFileSync(path, original);
    if (sha256(readFileSync(path)) !== sha256(original)) restoreFailures.push(mutant.id);
  }
});

rmSync(scratch, { recursive: true, force: true });

for (const row of rows) {
  process.stdout.write(`${row.id} ${row.status}  ${row.name}  [${row.file}]\n`);
  for (const killer of row.killers.slice(0, 3)) process.stdout.write(`    killed by: ${killer}\n`);
}
writeFileSync(
  join(ROOT, "packages/core/fixtures/server-mutants-result.json"),
  `${JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2)}\n`,
);
process.exitCode =
  rows.some((row) => !row.status.startsWith("KILLED")) || restoreFailures.length > 0 ? 1 : 0;
