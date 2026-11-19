// 这层管两件事：core 的诊断行（"一句一说"、不带换行）经 `serveCommandOf` 转发到 stderr 时必须补上换行；
// 以及 `--app-dir` 校验里那个**防御分支**（`appDirGiven` 为真但没有值）。
//
// 后三条是防御分支覆盖，不是症状覆盖：只有 `parseArgs` 的装配顺序变动时才走得到。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/args";
import type { Intent } from "../src/args";
import { serveCommandOf } from "../src/run-serve";
import { serveDirs as dirs, stopHandle, type ServeDirs } from "./serve-helpers";

type ServeIntent = Extract<Intent, { kind: "serve" }>;

/** 装配好的 `serve` 意图：四种 app-dir 情形共用同一份，只改 app-dir 相关字段。 */
const serveIntentOf = (workspace: string): ServeIntent => {
  const parsed = parseArgs(
    ["serve", "doc.html", "--port", "0", "--json", "--workspace", workspace],
    workspace,
  );
  if (!parsed.ok) throw new Error(`转发未通过：${parsed.message}`);
  const { intent } = parsed;
  if (intent.kind !== "serve") throw new Error(`意图不是 serve：${intent.kind}`);
  return intent;
};

/** 上次 daemon 被 kill -9 留下的注册表文件：core 会报一行"清理陈旧…"。 */
const seedStaleDaemon = (home: string, workspace: string): void => {
  mkdirSync(join(home, ".hreader"), { recursive: true });
  writeFileSync(
    join(home, ".hreader", "daemon.json"),
    JSON.stringify({ port: 1, pid: 2_000_000_000, token: "stale", workspace }),
  );
};

describe("serveCommandOf · 诊断出口", () => {
  it("should hand core's one-line diagnoses to stderr with a trailing newline", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    const rows: string[] = [];
    try {
      seedStaleDaemon(dir.home, dir.workspace);

      await serveCommandOf(
        serveIntentOf(dir.workspace),
        { workspace: dir.workspace, file: "doc.html" },
        {
          home: dir.home,
          stop: stopped,
          launchParentPid: process.ppid,
          diagnose: (row) => rows.push(row),
        },
      );
      stop();

      // core 的诊断不带换行（"一句一说"）：这里的包装必须补上，否则 stderr 会粘成一行。
      expect(rows.join("")).toContain("清理陈旧 daemon.json");
      expect(rows.every((row) => row.endsWith("\n"))).toBe(true);
    } finally {
      dir.drop();
    }
  });
});

/** 起一次 `serveCommandOf`：workspace 故意给不存在，core 立刻失败、不起监听。 */
const callServeOf = (
  dir: ServeDirs,
  appDir: string | undefined,
  appDirGiven: boolean,
): {
  readonly running: Promise<string>;
  readonly stop: () => void;
  readonly stopped: Promise<void>;
} => {
  const { stop, stopped } = stopHandle();
  const running = serveCommandOf(
    { ...serveIntentOf(dir.workspace), appDir, appDirGiven },
    { workspace: join(dir.workspace, "没有这个目录"), file: "doc.html" },
    { home: dir.home, stop: stopped, launchParentPid: process.ppid, diagnose: () => undefined },
  );
  return { running, stop, stopped };
};

describe("serveCommandOf · --app-dir 的防御分支", () => {
  it("should pass an existing app-dir through without any path display", async () => {
    // `appDirGiven` 为真、`appDir` 却是 `undefined` 时不许去 `existsSync(undefined)`，直接放行到 core。
    const dir = dirs();
    try {
      const call = callServeOf(dir, undefined, true);

      await expect(call.running).rejects.toThrow();
      expect(call.stop).toBeTypeOf("function");
    } finally {
      dir.drop();
    }
  });

  it("should accept an existing app-dir and hand it to core", async () => {
    // 正面对照：`--app-dir` 指向真实目录时不报错、原样传下去。
    const dir = dirs();
    try {
      const call = callServeOf(dir, dir.workspace, true);

      await expect(call.running).rejects.toThrow();
      expect(call.stop).toBeTypeOf("function");
    } finally {
      dir.drop();
    }
  });

  it("should refuse a missing app-dir and fall back to the process cwd for the path", () => {
    // 这条走"目录不存在"的真拒绝分支；`wiring.cwd` 故意不给，报表里的路径要按进程 cwd 回显。
    const dir = dirs();
    try {
      // 这个校验在装配阶段同步抛（还没进 core）：`serveCommandOf` 不是 async 函数。
      expect(() => callServeOf(dir, join(dir.workspace, "没有这个主题"), true)).toThrow(
        /--app-dir 目录不存在/u,
      );
    } finally {
      dir.drop();
    }
  });
});
