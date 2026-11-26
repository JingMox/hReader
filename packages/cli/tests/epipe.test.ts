// This layer covers how the process dies when the stdout downstream closes early (`| head -1`).
// Node does not swallow EPIPE on `process.stdout`: writing past a pipe buffer (64KiB) with the read end
// closed → the `'error'` event has no listener → uncaught exception → exit 1 + a screenful of stack. The
// contract: EPIPE is not a product failure — exit silently by the established semantics, no stack on stderr.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { epipeGuard } from "../src/epipe";
import { MAIN, withTempDir, type CliResult } from "./harness";

/** The read end is destroyed as the pipe is built: once the child fills the buffer, the next write must hit EPIPE (deterministic when the artifact >64KiB). */
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

/** `hr export` without `--out` pushes the whole printout to stdout: a ~200KiB doc guarantees crossing the pipe buffer. */
const BIG_DOC = `<!doctype html><html><body><article data-hr-id="hr-0"><h1 data-hr-id="hr-1">大文档</h1>${`<p data-hr-id="hr-x">${"填充文本".repeat(50)}</p>`.repeat(300)}</article></body></html>`;

describe("EPIPE · downstream closes early", () => {
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

describe("epipeGuard · unit level", () => {
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
    // emit() throws synchronously inside the listener: the error passes straight through to emit's caller.
    expect(() => {
      stream.emit("error", Object.assign(new Error("boom"), { code: "EBADF" }));
    }).toThrow("boom");
  });
});
