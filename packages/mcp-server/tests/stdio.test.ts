// 这层管：被交付的那个产物——AC-4 要求的高风险面。
// 测的是 `package.json` 的 `bin` 指向的 `dist/main.js`（宿主唯一会 spawn 的东西），不是 src：
// 真子进程、真 stdio，逐行验证 stdout 只有 JSON-RPC 帧。

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { isRecord } from "./harness";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const RESPONSE_COUNT = 4;

const REQUESTS = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "0.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "prompts/list" },
  { jsonrpc: "2.0", id: 4, method: "resources/list" },
];

interface Probe {
  readonly frames: readonly Record<string, unknown>[];
  readonly lineCount: number;
  readonly exitCode: number | null;
}

const framesOf = (lines: readonly string[]): readonly Record<string, unknown>[] =>
  lines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : {};
  });

/** 等响应齐了就关 stdin：stdio 传输随之收尾，进程自己退。 */
const exitCodeOf = async (child: ChildProcess, chunks: readonly string[]): Promise<number | null> =>
  new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP 进程在 15s 内没有把响应写完"));
    }, 15_000);
    const poll = setInterval(() => {
      if (
        chunks
          .join("")
          .split("\n")
          .filter((line) => line.trim() !== "").length >= RESPONSE_COUNT
      ) {
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

const probeOf = async (entry: string): Promise<Probe> => {
  const child = spawn(process.execPath, [entry], {
    cwd: PACKAGE_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => chunks.push(chunk));
  for (const request of REQUESTS) child.stdin.write(`${JSON.stringify(request)}\n`);

  const exitCode = await exitCodeOf(child, chunks);
  const lines = chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "");
  return { frames: framesOf(lines), lineCount: lines.length, exitCode };
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

beforeAll(() => {
  // 测交付物就先把它造出来：`build` 自己会清 dist，避免拿旧产物测新代码。
  execFileSync("pnpm", ["-C", PACKAGE_ROOT, "build"], { cwd: REPO_ROOT, stdio: "pipe" });
}, 180_000);

describe("dist/main.js · the thing a host actually spawns", () => {
  it("should point the package bin at the built artifact", async () => {
    const entry = await binPathOf();

    expect(entry.endsWith(join("dist", "main.js"))).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });

  it("should emit nothing but json-rpc frames on stdout", async () => {
    const { frames, lineCount, exitCode } = await probeOf(await binPathOf());

    expect(lineCount).toBe(RESPONSE_COUNT);
    expect(frames.every((frame) => frame["jsonrpc"] === "2.0")).toBe(true);
    expect(frames.every((frame) => frame["error"] === undefined)).toBe(true);
    expect(frames.map((frame) => frame["id"])).toEqual([1, 2, 3, 4]);
    expect(exitCode).toBe(0);
  }, 30_000);

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
