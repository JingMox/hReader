// 这层管：集成测试总入口——按套件起子进程串行跑（套件之间进程级隔离，端口/工作区各自随机），
// 汇总输出 + 按套件退出码给总退出码。用法：`node tests/integration/run.ts [suite 名...]`。

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupSandboxes } from "./harness/env.ts";
import { killAllTracked, run } from "./harness/proc.ts";

const SUITES_DIR = fileURLToPath(new URL("./suites/", import.meta.url));

const wanted = process.argv.slice(2);
const all = readdirSync(SUITES_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort();
const suites = wanted.length === 0 ? all : all.filter((f) => wanted.some((w) => f.startsWith(w)));

if (suites.length === 0) {
  process.stderr.write(`没有匹配的套件（可用：${all.join(", ")}）\n`);
  process.exit(2);
}

let failed = 0;
for (const suite of suites) {
  const at = Date.now();
  const res = await run(process.execPath, [join(SUITES_DIR, suite)], {
    timeoutMs: 8 * 60_000,
  });
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  const tail = res.stdout.trim().split("\n").at(-1) ?? "";
  const ok = res.code === 0 && (tail.startsWith("OK ") || tail.startsWith("SKIPPED "));
  if (!ok) {
    failed += 1;
    process.stdout.write(`SUITE-FAIL ${suite} (exit ${String(res.code)})\n`);
  } else {
    process.stdout.write(`SUITE-OK ${suite} (${String(Date.now() - at)}ms)\n`);
  }
}
killAllTracked();
cleanupSandboxes();
process.stdout.write(
  failed === 0 ? `全部 ${String(suites.length)} 个套件通过\n` : `${String(failed)} 个套件失败\n`,
);
process.exit(failed === 0 ? 0 : 1);
