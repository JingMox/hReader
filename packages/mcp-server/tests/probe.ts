// 这层管：`dist/main.js` 真子进程探针 + 握手帧常量——`stdio.test.ts`（宿主视角）与
// `stream.test.ts`（坏输入 / 超限帧）共用；两边各自 `beforeAll(buildDist)` 建一次产物。

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { open, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "./harness";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const HANDSHAKE_COUNT = 4;

export const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-test", version: "0.0.0" },
  },
};
export const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
export const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
export const PROMPTS_LIST = { jsonrpc: "2.0", id: 3, method: "prompts/list" };
export const RESOURCES_LIST = { jsonrpc: "2.0", id: 4, method: "resources/list" };

export const linesOf = (messages: readonly unknown[]): readonly string[] =>
  messages.map((message) => JSON.stringify(message));

export const HANDSHAKE = linesOf([
  INITIALIZE,
  INITIALIZED,
  TOOLS_LIST,
  PROMPTS_LIST,
  RESOURCES_LIST,
]);

/** 输入全坏：一行畸形 JSON、一条不认识的方法、一条缺参数的 `tools/call`、一条越界路径的 `tools/call`。 */
export const BROKEN_INPUT = [
  `{"jsonrpc":"2.0","id":`,
  ...linesOf([{ jsonrpc: "2.0", id: 5, method: "no/such/method" }]),
  ...linesOf([
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "hr_outline", arguments: {} } },
  ]),
  ...linesOf([
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "hr_outline", arguments: { filePath: "/etc/hosts" } },
    },
  ]),
];

export interface ProbeOptions {
  readonly lines?: readonly string[];
  readonly expected?: number;
  readonly cwd?: string;
}

export interface Probe {
  readonly frames: readonly Record<string, unknown>[];
  readonly lines: readonly string[];
  readonly stderrText: string;
  readonly exitCode: number | null;
}

export const framesOf = (lines: readonly string[]): readonly Record<string, unknown>[] =>
  lines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : {};
  });

export const nonEmptyOf = (chunks: readonly string[]): readonly string[] =>
  chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "");

/** 等响应齐了就关 stdin：stdio 传输随之收尾，进程自己退。 */
export const exitCodeOf = async (
  child: ChildProcess,
  chunks: readonly string[],
  expected: number,
): Promise<number | null> =>
  new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP 进程在 15s 内没有把响应写完"));
    }, 15_000);
    const poll = setInterval(() => {
      if (nonEmptyOf(chunks).length >= expected) {
        clearInterval(poll);
        child.stdin?.end();
      }
    }, 20);
    child.once("error", reject);
    child.once("close", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      resolve(code);
    });
  });

export const probeOf = async (entry: string, options: ProbeOptions = {}): Promise<Probe> => {
  const { lines = HANDSHAKE, expected = HANDSHAKE_COUNT, cwd = PACKAGE_ROOT } = options;
  const child = spawn(process.execPath, [entry], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: string[] = [];
  const errors: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => chunks.push(chunk));
  child.stderr.on("data", (chunk: string) => errors.push(chunk));
  for (const line of lines) child.stdin.write(`${line}\n`);

  const exitCode = await exitCodeOf(child, chunks, expected);
  const stdoutLines = nonEmptyOf(chunks);
  return {
    frames: framesOf(stdoutLines),
    lines: stdoutLines,
    stderrText: errors.join(""),
    exitCode,
  };
};

export const binPathOf = async (): Promise<string> => {
  const parsed: unknown = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const bin = isRecord(parsed) ? parsed["bin"] : undefined;
  const entry = isRecord(bin) ? bin["hreader-mcp"] : undefined;
  return typeof entry === "string" ? join(PACKAGE_ROOT, entry) : "";
};

export const toolNamesOf = (frames: readonly Record<string, unknown>[]): readonly string[] => {
  const result = frames[1]?.["result"];
  if (!isRecord(result) || !Array.isArray(result["tools"])) return [];
  return result["tools"].flatMap((one) =>
    isRecord(one) && typeof one["name"] === "string" ? [one["name"]] : [],
  );
};

export const errorCodeOf = (frame: Record<string, unknown> | undefined): unknown => {
  const error = frame?.["error"];
  return isRecord(error) ? error["code"] : undefined;
};

/** 响应顺序不跟输入顺序（同步能答的帧先出）：断言只能按 `id` 取，不能按下标。 */
export const byIdOf = (
  frames: readonly Record<string, unknown>[],
): Map<unknown, Record<string, unknown>> => new Map(frames.map((frame) => [frame["id"], frame]));

export const resultOf = (frame: Record<string, unknown> | undefined): Record<string, unknown> => {
  const result = frame?.["result"];
  return isRecord(result) ? result : {};
};

export const textOf = (frame: Record<string, unknown> | undefined): string => {
  const content = resultOf(frame)["content"];
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((one) => (isRecord(one) && typeof one["text"] === "string" ? [one["text"]] : []))
    .join("\n");
};

const BUILD_LOCK = join(tmpdir(), "hreader-mcp-dist-build.lock");

const sleepOf = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 跨进程锁：`vitest run packages/mcp-server` 会让多个测试文件**各自**在自己的进程里
 * `beforeAll(buildDist)`，而 `build` 先清 dist 再写——并发时另一个文件正好读到"清了一半"的产物，
 * 症状是 `Unexpected end of JSON input`（本文件曾因此在全包跑时假红）。锁文件放 tmpdir：
 * `build` 会清 dist，锁不能在里面。
 */
const buildLockOf = async (deadline: number): Promise<boolean> => {
  try {
    const handle = await open(BUILD_LOCK, "wx");
    await handle.close();
    return true;
  } catch {
    const stale = await stat(BUILD_LOCK).then(
      (info) => Date.now() - info.mtimeMs > 300_000,
      () => false,
    );
    if (stale || Date.now() > deadline) {
      if (stale) await rm(BUILD_LOCK, { force: true });
      if (Date.now() > deadline)
        throw new Error("等 dist 构建锁超时（另一个测试文件一直在建产物）");
    }
    await sleepOf(200);
    return false;
  }
};

/** 产物比所有输入都新就不用再建：并发文件排队拿到锁之后，第二个起直接跳过。 */
/** 目录下每个条目的 mtime，展平成一维给调用方取最大值。 */
const stampsOf = async (root: string): Promise<readonly number[]> => {
  const names = await readdir(root, { recursive: true });
  return Promise.all(
    names.map((name) =>
      stat(join(root, name)).then(
        (info) => info.mtimeMs,
        () => 0,
      ),
    ),
  );
};

/**
 * 产物必须比**所有会进 dist 的源**新：`src/**`、`package.json`，以及仓库根 `styles/**`——
 * build 会把 `styles/` 拷进包里，漏盯它就会出现"改了主题不重建，install-sim 拿上一次的拷贝当基准"。
 * 包内的 `styles/` 是生成物，不参与比较。
 */
const distIsFresh = async (): Promise<boolean> => {
  const built = await stat(join(PACKAGE_ROOT, "dist", "main.js")).then(
    (info) => info.mtimeMs,
    () => 0,
  );
  if (built === 0) return false;
  const stamps = [
    ...(await stampsOf(join(PACKAGE_ROOT, "src"))),
    ...(await stampsOf(join(REPO_ROOT, "styles"))),
    await stat(join(PACKAGE_ROOT, "package.json")).then(
      (info) => info.mtimeMs,
      () => 0,
    ),
  ];
  return built > Math.max(...stamps);
};

/** 测交付物就先把它造出来：`build` 自己会清 dist，避免拿旧产物测新代码。 */
export const buildDist = async (): Promise<void> => {
  const deadline = Date.now() + 300_000;
  for (;;) {
    if (await buildLockOf(deadline)) break;
  }
  try {
    if (await distIsFresh()) return;
    execFileSync("pnpm", ["-C", PACKAGE_ROOT, "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  } finally {
    await rm(BUILD_LOCK, { force: true });
  }
};

export interface OversizedProbe {
  readonly lines: readonly string[];
  readonly stderrText: string;
  readonly exitCode: number | null;
}

/**
 * 单帧越过 SDK 的 10MB `ReadBuffer` 之后：**不**主动关 stdin——传输自己调 `onerror` 再 close，
 * 进程随之退出。这就是"静默半死"与"留一条 stderr"的差别所在。
 */
export const oversizedProbeOf = async (entry: string, frame: string): Promise<OversizedProbe> => {
  const child = spawn(process.execPath, [entry], {
    cwd: PACKAGE_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  const errors: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => chunks.push(chunk));
  child.stderr.on("data", (chunk: string) => errors.push(chunk));
  // 传输先 close 时父进程可能还在写那 11MB：EPIPE 是预期噪声，不是被测对象。
  child.stdin.on("error", () => undefined);
  for (const line of HANDSHAKE) child.stdin.write(`${line}\n`);
  child.stdin.write(`${frame}\n`);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP 进程在超限帧之后 15s 仍没退出"));
    }, 15_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { lines: nonEmptyOf(chunks), stderrText: errors.join(""), exitCode };
};
