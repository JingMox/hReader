// 手写的源码变异 + 真跑：每个变异体替换一处文本，跑指定测试文件，退出码非 0 记 KILLED。
// 不依赖任何变异库；只读源码、改临时内容、`finally` 原样写回。

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../../../../", import.meta.url).pathname;

/** @type {{id:string; file:string; find:string; replace:string; target:string; expect:string}[]} */
const MUTANTS = [
  {
    id: "canvas-whole-reload",
    file: "packages/app/src/widgets/canvas.ts",
    find: "    if (markup !== undefined) host.blockHtml(id, markup);",
    replace: "    if (markup !== undefined) void markup;",
    target: "packages/app/tests/widgets.test.ts",
    expect: "整篇重注入 → 调用序列断言变红",
  },
  {
    id: "store-always-notify",
    file: "packages/app/src/store.ts",
    find: "    if (next === state) return;",
    replace: "    if (next === undefined) return;",
    target: "packages/app/tests/store.test.ts",
    expect: "同引用也通知 → 不通知断言变红",
  },
  {
    id: "keys-drop-editable-guard",
    file: "packages/app/src/keys.ts",
    find: "  if (modified(event) || isEditableTarget(event.target)) return undefined;",
    replace: "  if (modified(event)) return undefined;",
    target: "packages/app/tests/keys.test.ts",
    expect: "输入框里也触发快捷键 → 抑制断言变红",
  },
  {
    id: "sse-drop-stale",
    file: "packages/app/src/sse.ts",
    find: "    if (body === undefined || Number.isNaN(id) || isStale(ctl.lastSeen, id)) return;",
    replace: "    if (body === undefined || Number.isNaN(id)) return;",
    target: "packages/app/tests/sse.test.ts",
    expect: "旧 revision 不再丢弃 → stale 断言变红",
  },
  {
    id: "style-switch-drop-apply",
    file: "packages/app/src/style-switch.ts",
    find: "      deps.applyCss(css);",
    replace: "      void css;",
    target: "packages/app/tests/style-switch.test.ts",
    expect: "CSS 不落进 DOM → apply 断言变红",
  },
  {
    id: "reverse-allow-traversal",
    file: "packages/core/src/server/http-io.ts",
    find: '    (part) => part === "" || part === "." || part === ".." || part.length > MAX_SEGMENT_NAME,',
    replace: '    (part) => part === "" || part === "." || part.length > MAX_SEGMENT_NAME,',
    target: "packages/core/tests/server/static-app.test.ts",
    expect: "反向变异：放开 `..` → 穿越用例必须变红（证明防线有人在测）",
  },
];

const run = (target) =>
  spawnSync("npx", ["vitest", "run", target], {
    cwd: ROOT,
    timeout: 120_000,
    stdio: "pipe",
    encoding: "utf8",
  });

const results = [];
for (const mutant of MUTANTS) {
  const path = ROOT + mutant.file;
  const original = readFileSync(path, "utf8");
  if (!original.includes(mutant.find)) {
    results.push({ id: mutant.id, status: "STALE", detail: "find 文本不在了" });
    continue;
  }
  try {
    writeFileSync(path, original.replace(mutant.find, mutant.replace));
    const run1 = run(mutant.target);
    results.push({
      id: mutant.id,
      status: run1.status === 0 ? "SURVIVED" : "KILLED",
      exit: run1.status,
      expect: mutant.expect,
    });
  } finally {
    writeFileSync(path, original);
  }
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.some((row) => row.status !== "KILLED") ? 1 : 0;
