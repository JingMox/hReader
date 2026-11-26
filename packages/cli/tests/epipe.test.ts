// 这层管：stdout 下游提前关闭（`| head -1`）时进程的死法。
// Node 对 `process.stdout` 不吞 EPIPE：写超出一个管道缓冲（64KiB）且读端已关，
// `'error'` 事件无人接 → 未捕获异常 → exit 1 + 满屏栈。契约：EPIPE 不是产品失败，
// 按既定语义静默退出，stderr 不许漏栈。

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { epipeGuard } from "../src/epipe";
import { MAIN, withTempDir, type CliResult } from "./harness";

/** 读端建管即毁：子进程第一口写满缓冲后，下一口必撞 EPIPE（产物 >64KiB 时确定发生）。 */
const runCliClosedStdout = async (args: readonly string[], cwd: string): Promise<CliResult> =>
  new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", MAIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.destroy();
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, stdout: "", stderr, signal });
    });
  });

/** `hr export` 不写 `--out` 时把整份打印稿推给 stdout：一份 ~200KiB 的文档保证越过管道缓冲。 */
const BIG_DOC = `<!doctype html><html><body><article data-hr-id="hr-0"><h1 data-hr-id="hr-1">大文档</h1>${`<p data-hr-id="hr-x">${"填充文本".repeat(50)}</p>`.repeat(300)}</article></body></html>`;

describe("EPIPE · 下游提前关闭", () => {
  it("should exit 0 with a clean stderr when the export consumer closes early", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      writeFileSync(join(dir, "big.html"), BIG_DOC);

      const result = await runCliClosedStdout(["export", "big.html"], dir);

      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
    });
  });

  it("should exit 0 on a closed stdout for a plain outline too", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      writeFileSync(
        join(dir, "doc.html"),
        '<article data-hr-id="hr-0"><h1 data-hr-id="hr-1">标题</h1></article>',
      );

      const result = await runCliClosedStdout(["outline", "doc.html"], dir);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    });
  });
});

describe("epipeGuard · 单元层", () => {
  it("should exit with the pending exit code when an EPIPE arrives", () => {
    const stream = new EventEmitter();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    epipeGuard(stream);
    process.exitCode = 3;

    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(exit).toHaveBeenCalledWith(3);
    exit.mockRestore();
    process.exitCode = 0;
  });

  it("should exit 0 when no exit code is pending", () => {
    const stream = new EventEmitter();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    epipeGuard(stream);
    process.exitCode = undefined;

    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });

  it("should rethrow non-EPIPE errors untouched", () => {
    const stream = new EventEmitter();
    epipeGuard(stream);
    // emit() 在监听器内同步抛：error 原样穿透到 emit 的调用方。
    expect(() => {
      stream.emit("error", Object.assign(new Error("boom"), { code: "EBADF" }));
    }).toThrow("boom");
  });
});
