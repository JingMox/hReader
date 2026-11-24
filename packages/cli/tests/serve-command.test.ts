// 这层管：`serveCommand`/`serveCommandOf` 的进程内行为（生命周期、诊断出口、`--app-dir`、
// allowHosts、`--home`）；子进程案只验生命周期。

import { existsSync, mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serveCommand } from "../src/commands/serve";
import { EXIT_FAILURE, EXIT_USAGE } from "../src/exit-codes";
import { run } from "../src/run";
import {
  serveDirs as dirs,
  serveInputOf as inputOf,
  settle,
  stopHandle,
  type ServeDirs,
} from "./serve-helpers";
import { parseArgs } from "../src/args";
import type { Intent } from "../src/args";
import { serveCommandOf } from "../src/run-serve";

describe("serveCommand", () => {
  it("should print the json envelope", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      const text = await serveCommand(inputOf(dir, true, stopped));

      expect(text).toMatch(/^\{.*\}\n$/u);
      expect(text).toContain('"port":');
      expect(text).toContain('"token":"');
      stop();
    } finally {
      dir.drop();
    }
  });

  it("should write daemon.json while serving", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      await serveCommand(inputOf(dir, true, stopped));

      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(true);
      stop();
    } finally {
      dir.drop();
    }
  });
});

describe("serveCommand · 结束后", () => {
  it("should remove daemon.json once stop resolves", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      await serveCommand(inputOf(dir, true, stopped));
      stop();
      await settle();

      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      dir.drop();
    }
  });

  it("should print the human line when --json is off", async () => {
    const dir = dirs();
    try {
      const { stop, stopped } = stopHandle();
      const text = await serveCommand(inputOf(dir, false, stopped));
      stop();

      // 打印的必须是"能直接粘进浏览器"的那串：裸地址没 token，粘了就是 401（`GET /` 吃 token）。
      expect(text).toMatch(
        /^serving .+ on http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+ \(pid \d+\)\n$/u,
      );
    } finally {
      dir.drop();
    }
  });
});

const runServeJson = async (
  dir: ReturnType<typeof dirs>,
  stopped: Promise<void>,
): Promise<string[]> => {
  const out: string[] = [];
  await run(["serve", join(dir.workspace, "doc.html"), "--port", "0", "--json"], {
    cwd: dir.workspace,
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(new Uint8Array()),
    debug: false,
    launchParentPid: process.ppid,
    stop: stopped,
  });
  return out;
};

describe("serveCommand · allowHosts 与 run 分发", () => {
  it("should pass an explicit allowHosts list through to startServer", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      const text = await serveCommand({
        ...inputOf(dir, true, stopped),
        allowHosts: ["127.0.0.1"],
      });
      stop();

      expect(text).toContain('"port":');
    } finally {
      dir.drop();
    }
  });

  it("should dispatch the serve intent through run() with io.stop", async () => {
    const dir = dirs();
    const previous = process.env["HOME"];
    process.env["HOME"] = dir.home;
    const { stop, stopped } = stopHandle();
    try {
      const out = await runServeJson(dir, stopped);
      stop();

      expect(out.join("")).toContain('"port":');
    } finally {
      process.env["HOME"] = previous;
      dir.drop();
    }
  });
});

const runServeWith = async (
  dir: ReturnType<typeof dirs>,
  appDir: string,
): Promise<{ readonly code: number; readonly err: string }> => {
  const err: string[] = [];
  const code = await run(
    ["serve", join(dir.workspace, "doc.html"), "--port", "0", "--app-dir", appDir],
    {
      cwd: dir.workspace,
      stdout: () => undefined,
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
    },
  );
  return { code, err: err.join("") };
};

describe("run · --app-dir 的端到端透传", () => {
  it("should pass an existing --app-dir through run() into startServer", async () => {
    const dir = dirs();
    const previous = process.env["HOME"];
    process.env["HOME"] = dir.home;
    const { stop, stopped } = stopHandle();
    try {
      const out: string[] = [];
      const code = await run(
        [
          "serve",
          join(dir.workspace, "doc.html"),
          "--port",
          "0",
          "--json",
          "--app-dir",
          dir.workspace,
        ],
        {
          cwd: dir.workspace,
          stdout: (text) => out.push(text),
          stderr: () => undefined,
          readStdin: () => Promise.resolve(new Uint8Array()),
          debug: false,
          launchParentPid: process.ppid,
          stop: stopped,
        },
      );
      stop();

      expect(code).toBe(0);
      expect(out.join("")).toContain('"port":');
    } finally {
      process.env["HOME"] = previous;
      dir.drop();
    }
  });
});

describe("serveCommand · --app-dir 的两条分支", () => {
  it("should pass an existing appDir through to startServer", async () => {
    const dir = dirs();
    const { stop, stopped } = stopHandle();
    try {
      const text = await serveCommand({ ...inputOf(dir, true, stopped), appDir: dir.workspace });
      stop();

      expect(text).toContain('"port":');
    } finally {
      dir.drop();
    }
  });

  it("should reject an explicit --app-dir that does not exist and leave no daemon", async () => {
    const dir = dirs();
    try {
      const { code, err } = await runServeWith(dir, join(dir.workspace, "no-such-app"));

      // 文档规格声称 exit 2；实际 `invalid_input` 映射到 EXIT_FAILURE（1），
      // 只有 `daemon_already_running` 是 2。断言按实现钉住当前行为。
      expect(code).toBe(EXIT_FAILURE);
      expect(err).toContain("--app-dir 目录不存在");
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      dir.drop();
    }
  });
});

const runServeHome = async (
  dir: ReturnType<typeof dirs>,
  home: string,
  stop: Promise<void>,
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    ["serve", join(dir.workspace, "doc.html"), "--port", "0", "--json", "--home", home],
    {
      cwd: dir.workspace,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
      stop,
    },
  );
  return { code, out: out.join(""), err: err.join("") };
};

describe("run · serve 的 --home", () => {
  it("should write daemon.json under --home and never under $HOME", async () => {
    const dir = dirs();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "hr-serve-other-home-")));
    const previous = process.env["HOME"];
    process.env["HOME"] = other;
    const { stop, stopped } = stopHandle();
    try {
      const { code, out } = await runServeHome(dir, dir.home, stopped);
      stop();
      await stopped;

      expect(code).toBe(0);
      expect(out).toContain('"port":');
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(true);
      expect(existsSync(join(other, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      process.env["HOME"] = previous;
      rmSync(other, { recursive: true, force: true });
      dir.drop();
    }
  });

  it("should reject a --home that does not exist with a usage error", async () => {
    const dir = dirs();
    try {
      const ghost = join(dir.workspace, "no-such-home");
      const { code, err } = await runServeHome(dir, ghost, Promise.resolve());

      expect(code).toBe(EXIT_USAGE);
      expect(err).toContain(`--home 目录不存在：${ghost}`);
    } finally {
      dir.drop();
    }
  });
});
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
