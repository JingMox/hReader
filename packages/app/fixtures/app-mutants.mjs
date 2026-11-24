// 这层管：app 的变异套件（真跑）——每个变异体落到 `packages/app/src`，跑**对应**测试文件，
// 记录"被杀/存活"，最后恢复原文件。反向变异（把安全/契约逻辑改坏）必须变红。

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const APP = `${ROOT}packages/app/`;

/** `tests` 是相对 `packages/app/tests` 的文件名；空表示整包 app 测试。 */
const MUTANTS = [
  {
    label: "keys: 忽略修饰键（⌘J 也触发）",
    file: "src/keys.ts",
    from: "if (modified(event) || isEditableTarget(event.target)) return undefined;",
    to: "if (isEditableTarget(event.target)) return undefined;",
    tests: ["keys.test.ts"],
  },
  {
    label: "keys: 焦点在输入框时不抑制",
    file: "src/keys.ts",
    from: "if (modified(event) || isEditableTarget(event.target)) return undefined;",
    to: "if (modified(event)) return undefined;",
    tests: ["keys.test.ts"],
  },
  {
    label: "state: blocksLoaded 同列表也返回新引用（丢短路）",
    file: "src/state.ts",
    from: "const same = sameList(state.blocks, intent.blocks) && state.outline === intent.outline;",
    to: "const same = sameList(state.blocks, intent.blocks) && state.outline !== intent.outline;",
    tests: ["state.test.ts"],
  },
  {
    label: "sse: 退避上限从 30s 改成 60s",
    file: "src/sse.ts",
    from: "const CAP_MS = 30_000;",
    to: "const CAP_MS = 60_000;",
    tests: ["sse.test.ts"],
  },
  {
    label: "sse: 同一 id 的重放不再丢弃（>= 改成 >）",
    file: "src/sse.ts",
    from: "const isStale = (lastEventId: string, id: number): boolean => Number(lastEventId) >= id;",
    to: "const isStale = (lastEventId: string, id: number): boolean => Number(lastEventId) > id;",
    tests: ["sse.test.ts"],
  },
  {
    label: "sse: 反向变异——彻底不判 stale（重放/乱序全部放行）",
    file: "src/sse.ts",
    from: "const isStale = (lastEventId: string, id: number): boolean => Number(lastEventId) >= id;",
    to: "const isStale = (lastEventId: string, id: number): boolean => Number(lastEventId) >= 0 && false;",
    tests: ["sse.test.ts"],
  },
  {
    label: "style-switch: 丢掉幂等短路（同主题也重写）",
    file: "src/style-switch.ts",
    from: 'if (id === current || id === applied) return { status: "unchanged", id };',
    to: 'if (id === current && id === applied) return { status: "unchanged", id };',
    tests: ["style-switch.test.ts"],
  },
  {
    label: "store: 同引用也通知订阅者",
    file: "src/store.ts",
    from: "if (next === state) return;",
    to: "if (next !== state && false) return;",
    tests: ["store.test.ts"],
  },
  {
    label: "library: outline 没换也重建 TOC（反向）",
    file: "src/widgets/library.ts",
    from: "if (next.outline !== outline) {",
    to: "if (next.outline !== outline || true) {",
    tests: ["widgets.test.ts"],
  },
  {
    label: "canvas: doc.changed 整篇重载（反向变异）",
    file: "src/widgets/canvas.ts",
    from: "      diffBlocks(host, next, known);",
    to: "      host.html(`${parent} #hr-doc`, next.documentHtml);",
    tests: ["widgets.test.ts"],
  },
  {
    label: "dom: blockHtml 相同内容也重写",
    file: "src/dom.ts",
    from: "if (element !== undefined && element.innerHTML !== markup) element.innerHTML = markup;",
    to: "if (element !== undefined) element.innerHTML = markup;",
    tests: ["dom.test.ts"],
  },
];

const run = (tests) => {
  const args = ["vitest", "run", ...tests.map((test) => `packages/app/tests/${test}`)];
  const result = spawnSync("npx", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  return result.status;
};

const outcome = (status) => (status === 0 ? "SURVIVED（测试没抓到）" : "KILLED");

const main = () => {
  let survived = 0;
  for (const mutant of MUTANTS) {
    const path = `${APP}${mutant.file}`;
    const original = readFileSync(path, "utf8");
    if (!original.includes(mutant.from)) {
      process.stdout.write(`⚠️  未找到变异点：${mutant.label}\n`);
      survived += 1;
      continue;
    }
    try {
      writeFileSync(path, original.replace(mutant.from, mutant.to), "utf8");
      const status = run(mutant.tests);
      if (status === 0) survived += 1;
      process.stdout.write(`${outcome(status)}  ${mutant.label}  (${mutant.file})\n`);
    } finally {
      writeFileSync(path, original, "utf8");
    }
  }
  process.stdout.write(
    `\n${MUTANTS.length} 个变异体，存活 ${survived}，被杀 ${MUTANTS.length - survived}\n`,
  );
  return survived;
};

process.exitCode = main() === 0 ? 0 : 1;
