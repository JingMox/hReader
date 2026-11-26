// This layer: the real-subprocess probe for `dist/main.js` + handshake-frame constants — shared by `stdio.test.ts` (host's view) and
// `stream.test.ts` (broken input / oversized frames); each side runs `beforeAll(buildDist)` to build artifacts once.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { open, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerChild } from "../../../tests/leak-guard/registry.ts";
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

/** All-bad input: one malformed JSON line, one unknown method, one `tools/call` missing parameters, one `tools/call` with an out-of-bounds path. */
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

/** Close stdin once the responses are in: the stdio transport winds down and the process exits by itself. */
export const exitCodeOf = async (
  child: ChildProcess,
  chunks: readonly string[],
  expected: number,
): Promise<number | null> =>
  new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP process did not finish writing its response within 15s"));
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
  registerChild(child);
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

/** Response order does not follow input order (frames answerable synchronously come out first): assertions must pick by `id`, never by index. */
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
 * Cross-process lock: `vitest run packages/mcp-server` lets multiple test files **each** run
 * `beforeAll(buildDist)` in their own process, and `build` clears dist before writing — concurrently, another file can read a "half-cleared" artifact,
 * surfacing as `Unexpected end of JSON input` (this file once went falsely red on full-package runs). The lock file lives in tmpdir:
 * `build` clears dist, so the lock cannot sit inside it.
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
        throw new Error(
          "timed out waiting for the dist build lock (another test file kept building artifacts)",
        );
    }
    await sleepOf(200);
    return false;
  }
};

/** If the artifact is newer than every input, skip rebuilding: after queued files acquire the lock, the second one skips straight ahead. */
/** mtime of every entry under the directory, flattened to one dimension for the caller to take the max. */
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
 * The artifact must be newer than **every source that ends up in dist**: `src/**`, `package.json`, and the repo-root `styles/**` —
 * build copies `styles/` into the package, and missing it means "changed theme, no rebuild, install-sim benchmarks against the previous copy".
 * The in-package `styles/` is a generated artifact and does not join the comparison.
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

/** To test the deliverable, build it first: `build` clears dist itself, keeping stale artifacts out of new-code tests. */
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
 * After a single frame overflows the SDK's 10MB `ReadBuffer`: do **not** close stdin proactively — the transport calls `onerror` then closes itself,
 * and the process exits with it. This is the difference between "silently half-dead" and "leaves one stderr line".
 */
export const oversizedProbeOf = async (entry: string, frame: string): Promise<OversizedProbe> => {
  const child = spawn(process.execPath, [entry], {
    cwd: PACKAGE_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  registerChild(child);
  const chunks: string[] = [];
  const errors: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => chunks.push(chunk));
  child.stderr.on("data", (chunk: string) => errors.push(chunk));
  // When the transport closes first, the parent may still be writing those 11MB: EPIPE is expected noise, not the subject under test.
  child.stdin.on("error", () => undefined);
  for (const line of HANDSHAKE) child.stdin.write(`${line}\n`);
  child.stdin.write(`${frame}\n`);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP process still has not exited 15s after the oversized frame"));
    }, 15_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  return { lines: nonEmptyOf(chunks), stderrText: errors.join(""), exitCode };
};
