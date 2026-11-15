// 这层管：被交付的那个产物——AC-4 要求的高风险面。
// 测的是 `package.json` 的 `bin` 指向的 `dist/main.js`（宿主唯一会 spawn 的东西），不是 src：
// 真子进程、真 stdio，逐行验证 stdout 只有 JSON-RPC 帧；错误路径同样不许往 stdout 漏一个字符。

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { ANNOTATED_DOC, isRecord } from "./harness";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HANDSHAKE_COUNT = 4;

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-test", version: "0.0.0" },
  },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const TOOLS_LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const PROMPTS_LIST = { jsonrpc: "2.0", id: 3, method: "prompts/list" };
const RESOURCES_LIST = { jsonrpc: "2.0", id: 4, method: "resources/list" };

const linesOf = (messages: readonly unknown[]): readonly string[] =>
  messages.map((message) => JSON.stringify(message));

const HANDSHAKE = linesOf([INITIALIZE, INITIALIZED, TOOLS_LIST, PROMPTS_LIST, RESOURCES_LIST]);

/** 输入全坏：一行畸形 JSON、一条不认识的方法、一条缺参数的 `tools/call`、一条越界路径的 `tools/call`。 */
const BROKEN_INPUT = [
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

interface ProbeOptions {
  readonly lines?: readonly string[];
  readonly expected?: number;
  readonly cwd?: string;
}

interface Probe {
  readonly frames: readonly Record<string, unknown>[];
  readonly lines: readonly string[];
  readonly stderrText: string;
  readonly exitCode: number | null;
}

const framesOf = (lines: readonly string[]): readonly Record<string, unknown>[] =>
  lines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : {};
  });

const nonEmptyOf = (chunks: readonly string[]): readonly string[] =>
  chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "");

/** 等响应齐了就关 stdin：stdio 传输随之收尾，进程自己退。 */
const exitCodeOf = async (
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

const probeOf = async (entry: string, options: ProbeOptions = {}): Promise<Probe> => {
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

const binPathOf = async (): Promise<string> => {
  const parsed: unknown = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const bin = isRecord(parsed) ? parsed["bin"] : undefined;
  const entry = isRecord(bin) ? bin["hreader-mcp"] : undefined;
  return typeof entry === "string" ? join(PACKAGE_ROOT, entry) : "";
};

const toolNamesOf = (frames: readonly Record<string, unknown>[]): readonly string[] => {
  const result = frames[1]?.["result"];
  if (!isRecord(result) || !Array.isArray(result["tools"])) return [];
  return result["tools"].flatMap((one) =>
    isRecord(one) && typeof one["name"] === "string" ? [one["name"]] : [],
  );
};

const errorCodeOf = (frame: Record<string, unknown> | undefined): unknown => {
  const error = frame?.["error"];
  return isRecord(error) ? error["code"] : undefined;
};

/** 响应顺序不跟输入顺序（同步能答的帧先出）：断言只能按 `id` 取，不能按下标。 */
const byIdOf = (
  frames: readonly Record<string, unknown>[],
): Map<unknown, Record<string, unknown>> => new Map(frames.map((frame) => [frame["id"], frame]));

const resultOf = (frame: Record<string, unknown> | undefined): Record<string, unknown> => {
  const result = frame?.["result"];
  return isRecord(result) ? result : {};
};

const textOf = (frame: Record<string, unknown> | undefined): string => {
  const content = resultOf(frame)["content"];
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((one) => (isRecord(one) && typeof one["text"] === "string" ? [one["text"]] : []))
    .join("\n");
};

beforeAll(() => {
  // 测交付物就先把它造出来：`build` 自己会清 dist，避免拿旧产物测新代码。
  execFileSync("pnpm", ["-C", PACKAGE_ROOT, "build"], { cwd: REPO_ROOT, stdio: "pipe" });
}, 180_000);

describe("dist/main.js · the thing a host spawns", () => {
  it("should point the package bin at the built artifact", async () => {
    const entry = await binPathOf();

    expect(entry.endsWith(join("dist", "main.js"))).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });

  it("should ship the artifact executable with a shebang so a host can exec it directly", async () => {
    const entry = await binPathOf();
    const [firstLine] = (await readFile(entry, "utf8")).split("\n");

    expect(firstLine).toBe("#!/usr/bin/env node");
    expect(statSync(entry).mode & 0o111).not.toBe(0);
  });

  it("should emit nothing but json-rpc frames on stdout", async () => {
    const { frames, lines, exitCode } = await probeOf(await binPathOf());

    expect(lines.length).toBe(HANDSHAKE_COUNT);
    expect(frames.every((frame) => frame["jsonrpc"] === "2.0")).toBe(true);
    expect(frames.every((frame) => frame["error"] === undefined)).toBe(true);
    expect(frames.map((frame) => frame["id"])).toEqual([1, 2, 3, 4]);
    expect(exitCode).toBe(0);
  }, 30_000);
});

describe("dist/main.js · tool surface", () => {
  it("should keep the tool list complete inside that clean stream", async () => {
    const { frames } = await probeOf(await binPathOf());

    expect([...toolNamesOf(frames)].sort()).toEqual([
      "hr_apply_style",
      "hr_create_doc",
      "hr_outline",
      "hr_patch_node",
      "hr_read_node",
      "hr_resolve_annotation",
    ]);
  }, 30_000);
});

describe("dist/main.js · broken input", () => {
  it("should answer broken input with json-rpc frames and log the rest to stderr", async () => {
    const { lines, frames, stderrText, exitCode } = await probeOf(await binPathOf(), {
      lines: [...HANDSHAKE, ...BROKEN_INPUT],
      expected: HANDSHAKE_COUNT + 3,
    });
    const byId = byIdOf(frames);

    // ① 每一行都还是 JSON-RPC：畸形行让 SDK 直接丢弃（不回 -32700、也不给 id:null），
    //    进程没崩、stdout 也没多出任何非协议文本。
    expect(byId.has(null)).toBe(false);
    expect(frames.every((frame) => frame["jsonrpc"] === "2.0")).toBe(true);
    expect([...byId.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // ② 三种坏输入各自的答复：未知方法 / 缺参数 / 越界路径。
    expect(errorCodeOf(byId.get(5))).toBe(-32601);
    expect(resultOf(byId.get(6))["isError"]).toBe(true);
    expect(resultOf(byId.get(7))["isError"]).toBe(true);
    expect(textOf(byId.get(7))).toContain("[path_outside_workspace]");

    // ③ 日志真的走 stderr（含前缀与工具名），stdout 里一个字符都没有。
    expect(stderrText).toContain("[hreader-mcp]");
    expect(stderrText).toContain("hr_outline");
    expect(lines.join("")).not.toContain("[hreader-mcp]");
    expect(exitCode).toBe(0);
  }, 45_000);
});

describe("dist/main.js · self-contained", () => {
  it("should run a real tools/call with no node_modules anywhere near it", async () => {
    // 唯一能证明"自包含"的办法：把产物拷到一个没有任何依赖的目录，然后真的调一次工具。
    const hostDir = await mkdtemp(join(tmpdir(), "hreader-host-sim-"));
    try {
      const entry = await binPathOf();
      await copyFile(entry, join(hostDir, "main.js"));
      await writeFile(join(hostDir, "doc.html"), ANNOTATED_DOC, "utf8");
      expect(existsSync(join(hostDir, "node_modules"))).toBe(false);

      const { frames, stderrText } = await probeOf(join(hostDir, "main.js"), {
        cwd: hostDir,
        lines: linesOf([
          INITIALIZE,
          INITIALIZED,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "hr_outline", arguments: { filePath: "doc.html" } },
          },
        ]),
        expected: 2,
      });

      const answer = byIdOf(frames).get(2);
      const outline: unknown = JSON.parse(textOf(answer));
      expect(resultOf(answer)["isError"]).toBeUndefined();
      expect(isRecord(outline) && Array.isArray(outline["nodes"])).toBe(true);
      expect(isRecord(outline) ? outline["wordCount"] : 0).toBeGreaterThan(0);
      expect(stderrText).toBe("");
    } finally {
      await rm(hostDir, { recursive: true, force: true });
    }
  }, 45_000);
});
