#!/usr/bin/env node
// `pnpm verify` 与 `.github/workflows/ci.yml` 的 `checks` job 必须**同序同集**（§11.49：
// 门禁不在 CI 里 = 门禁只在你的笔记本上）。集合相等不够：`&&` 串联是 fail-fast 语义，顺序本身是判据。
//
// 多行 `run: |` 一律 fail-closed，不做"看不懂就跳过"：§11.47-2 的教训是判据必须是退出码，
// 静默跳过等于允许把门禁藏进多行块里（MV-4）。
//
// 能力边界（别高估这道门禁，§11.52）：本脚本只证明
//   1. 两侧 `- run:` 步骤列表同序同集；
//   2. 这些步骤没有被修饰成永不失败——步骤级的 `continue-on-error`/`if`/`shell`/
//      `working-directory`/`env`，以及 `checks` job 级的 `if:`，一律非 0 拒绝。
// 它**不**证明步骤真被执行（命令可以立刻 exit 0），也**不**检查脚本内容——
// 命令是否有效由 `lint:sh` 与各步自己的测试负责。`desktop` job 整块不参与比对。
//
// `--ci <path>` / `--verify <path>` 只给 selftest 用（/tmp 副本打靶），默认指向仓库内的两份文件。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CI = resolve(HERE, "../.github/workflows/ci.yml");
const DEFAULT_VERIFY = resolve(HERE, "../package.json");
// D3：白名单只有这一条（装依赖不是门禁步骤）。
const WHITELIST = new Set(["pnpm install --frozen-lockfile"]);
const SINGLE_RUN = /^\s*- run: pnpm (\S+)$/;
const JOB_BOUNDARY = /^ {2}\S.*:\s*$/;

function emit(text) {
  process.stdout.write(`${text}\n`);
}

function abort(lines) {
  for (const line of lines) emit(line);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { ci: DEFAULT_CI, verify: DEFAULT_VERIFY, targeted: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== "--ci" && flag !== "--verify") abort([`未知参数：${flag}`]);
    const value = argv[i + 1];
    if (value === undefined) abort([`${flag} 缺少路径`]);
    args[flag === "--ci" ? "ci" : "verify"] = resolve(value);
    args.targeted = true;
    i += 1;
  }
  return args;
}

function readVerifySteps(path) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const verify = pkg.scripts === undefined ? undefined : pkg.scripts.verify;
  if (typeof verify !== "string") abort([`${path} 里没有 scripts.verify`]);
  return verify.split("&&").map((part) => {
    const step = part.trim();
    const match = /^pnpm (\S+)$/.exec(step);
    if (match === null) abort([`verify 里无法解析的步骤：${step}`]);
    return match[1];
  });
}

// 步骤级修饰键：任何一个都能让 `- run: pnpm <x>` 在 CI 里永不失败（§11.52）。
const FORBIDDEN_STEP_KEYS = ["continue-on-error", "if", "shell", "working-directory", "env"];
const JOB_LEVEL_IF = /^ {4}if\s*:/;
const STEP_KEY = /^\s*([A-Za-z0-9_-]+)\s*:/;
const STEP_BODY_INDENT = 7;

function checksJobBody(lines) {
  const start = lines.findIndex((line) => /^ {2}checks:\s*$/.test(line));
  if (start < 0) abort(["ci.yml 里找不到 checks job"]);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => JOB_BOUNDARY.test(line));
  // body[0] 在原文件里的 0 基下标是 start + 1，故 1 基行号为 start + 2。
  return { body: end < 0 ? rest : rest.slice(0, end), firstLine: start + 2 };
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function assertStepUnmodified(body, stepIndex, firstLine) {
  const stepLine = body[stepIndex];
  const trimmed = stepLine.trim();
  for (let j = stepIndex + 1; j < body.length && indentOf(body[j]) >= STEP_BODY_INDENT; j += 1) {
    const key = STEP_KEY.exec(body[j]);
    if (key === null || !FORBIDDEN_STEP_KEYS.includes(key[1])) continue;
    abort([
      `步骤级修饰键会旁路门禁（§11.52），拒绝继续：ci.yml:${firstLine + j} \`${body[j].trim()}\``,
      `  键 ${key[1]}: 作用于 ci.yml:${firstLine + stepIndex} 的 \`${trimmed}\``,
    ]);
  }
}

function readCiSteps(path) {
  const { body, firstLine } = checksJobBody(readFileSync(path, "utf8").split("\n"));
  const steps = [];
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i];
    const trimmed = line.trim();
    // 作业级 `if:` 会让整个 job 跳过，比对步骤表毫无意义。`needs:`/`timeout-minutes:`/
    // `runs-on:` 等不影响门禁是否生效，放行。
    if (JOB_LEVEL_IF.test(line)) {
      abort([
        `作业级 if: 会让整个 job 跳过（§11.52），拒绝继续：ci.yml:${firstLine + i} \`${trimmed}\``,
      ]);
    }
    if (!trimmed.startsWith("- run:")) continue;
    const command = trimmed.slice("- run:".length).trim();
    if (command.startsWith("|")) {
      abort([`不支持多行 run（fail-closed）：${trimmed}`]);
    }
    assertStepUnmodified(body, i, firstLine);
    if (WHITELIST.has(command)) continue;
    const match = SINGLE_RUN.exec(line);
    if (match === null) {
      abort([`无法解析的 run：${trimmed}（只认整行 \`- run: pnpm <script>\`）`]);
    }
    steps.push(match[1]);
  }
  return steps;
}

function firstDiff(verifySteps, ciSteps) {
  const length = Math.max(verifySteps.length, ciSteps.length);
  for (let i = 0; i < length; i += 1) {
    if (verifySteps[i] !== ciSteps[i]) {
      const left = verifySteps[i] ?? "<无>";
      const right = ciSteps[i] ?? "<无>";
      return `第 ${i + 1} 步 verify=${left} ci=${right}`;
    }
  }
  return "无";
}

function printTable(label, steps) {
  steps.forEach((step, index) => emit(`  ${label}[${index + 1}] = ${step}`));
}

function runCheck(ciPath, verifyPath) {
  const verifySteps = readVerifySteps(verifyPath);
  const ciSteps = readCiSteps(ciPath);
  const missing = verifySteps.filter((step) => !ciSteps.includes(step));
  const extra = ciSteps.filter((step) => !verifySteps.includes(step));
  const ordered =
    verifySteps.length === ciSteps.length &&
    verifySteps.every((step, index) => ciSteps[index] === step);
  if (missing.length === 0 && extra.length === 0 && ordered) {
    emit(`[parity] OK：verify 与 ci.yml checks 同序同集（${verifySteps.length} 步）`);
    printTable("verify", verifySteps);
    printTable("ci.yml checks", ciSteps);
    return;
  }
  abort([
    "[parity] FAIL：verify 与 ci.yml checks 不对齐（§11.49：少一步就是本地绿、CI 不查）",
    `  缺失（verify 有、ci 没有）：${missing.length === 0 ? "无" : missing.join(", ")}`,
    `  多余（ci 有、verify 没有）：${extra.length === 0 ? "无" : extra.join(", ")}`,
    `  乱序：${ordered ? "无" : firstDiff(verifySteps, ciSteps)}`,
  ]);
}

// 反例自证（§11.47：新门禁落地的第一件事是看它真红）。只改 /tmp 副本，不碰仓库。
function mutate(ciText, kind) {
  const lines = ciText.split("\n");
  const knipAt = lines.findIndex((line) => line.includes("- run: pnpm knip"));
  if (kind === "missing") {
    lines.splice(knipAt, 1);
  } else if (kind === "extra") {
    // 插入 verify 里**没有**的步骤：只触发"多余"，不掺杂乱序。
    const at = lines.findIndex((line) => /^ {2}desktop:\s*$/.test(line));
    lines.splice(at, 0, "      - run: pnpm nope");
  } else if (kind === "order") {
    const at = lines.findIndex((line) => line.includes("- run: pnpm format:check"));
    const swapped = lines[at];
    lines[at] = lines[at + 1];
    lines[at + 1] = swapped;
  } else if (kind === "multiline") {
    lines[knipAt] = "      - run: |\n        pnpm knip";
  } else if (kind === "continue-on-error") {
    lines.splice(knipAt + 1, 0, "        continue-on-error: true");
  } else if (kind === "job-if") {
    const at = lines.findIndex((line) => /^ {2}checks:\s*$/.test(line));
    lines.splice(at + 1, 0, "    if: false");
  } else {
    throw new Error(`未知的 selftest 变异：${kind}`);
  }
  return lines.join("\n");
}

// 期望值（退出码 + 专属串 + 不含其它 case 的串）只写在**父进程**；子进程只负责"判"。
// 两边不同源，这是 R3-a 补的洞：旧版 selftest 的最终回执也走 `abort()`→`process.exit(1)`，
// 与被告共用同一条退出路径——有人把子进程的 `exit(1)` 改成 `exit(0)`，整条命令就跟着变绿。
// 现在父进程的失败回执走 `process.exitCode`（不是 `process.exit(1)`），即使子进程把所有反例
// 都判绿，父进程仍能把整条命令打红。
const EXPECTED_FAIL_RC = 1;
// 每个 case 断言**自己专属**的期望串，并断言其它 case 的期望串不出现：
// abort 可能同时打印多个标签，只匹配公共标签等于重言（P2-2）。
const SELFTEST_CASES = [
  { kind: "missing", expect: "缺失（verify 有、ci 没有）：knip" },
  { kind: "extra", expect: "多余（ci 有、verify 没有）：nope" },
  { kind: "order", expect: "乱序：第 1 步 verify=format:check ci=check-ci-parity" },
  { kind: "multiline", expect: "不支持多行 run" },
  { kind: "continue-on-error", expect: "步骤级修饰键会旁路门禁（§11.52）" },
  { kind: "job-if", expect: "作业级 if: 会让整个 job 跳过" },
];

function runSelftest() {
  const dir = mkdtempSync(join(tmpdir(), "ci-parity-"));
  const failures = [];
  try {
    const verifyPath = join(dir, "package.json");
    writeFileSync(verifyPath, readFileSync(DEFAULT_VERIFY));
    const base = readFileSync(DEFAULT_CI, "utf8");
    const expected = SELFTEST_CASES.map((item) => item.expect);
    for (const { kind, expect } of SELFTEST_CASES) {
      const ciPath = join(dir, `${kind}.yml`);
      writeFileSync(ciPath, mutate(base, kind));
      const run = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "--ci", ciPath, "--verify", verifyPath],
        {
          encoding: "utf8",
        },
      );
      const output = `${run.stdout}${run.stderr}`;
      const leaked = expected.filter((other) => other !== expect && output.includes(other));
      const passed =
        run.status === EXPECTED_FAIL_RC && output.includes(expect) && leaked.length === 0;
      emit(
        `[parity][selftest] case=${kind} rc=${run.status} expect-rc=${EXPECTED_FAIL_RC} expect-string=${JSON.stringify(expect)} leaked=${JSON.stringify(leaked)} ${passed ? "PASS" : "FAIL"}`,
      );
      if (!passed) failures.push(kind);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    // 刻意不用 abort()／process.exit(1)：那是被测子进程的退出路径，共用就会被一起改哑。
    emit(`[parity] FAIL：selftest 反例没变红：${failures.join(", ")}`);
    process.exitCode = EXPECTED_FAIL_RC;
    return;
  }
  emit("[parity] OK：selftest 六个反例全部变红（缺步/多步/乱序/多行 run/步骤修饰键/作业级 if）");
}

const args = parseArgs(process.argv.slice(2));
runCheck(args.ci, args.verify);
if (!args.targeted) runSelftest();
