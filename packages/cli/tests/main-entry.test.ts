// 这层管：`main.ts` 的进程壳（argv/env/stdin → run → process.exitCode），在进程内跑一次；
// 真正的子进程行为在 cli-process.test.ts（这里只补覆盖率够不到的壳代码）。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-main-")));
const DOC = '<article data-hr-id="hr-a"><p data-hr-id="hr-b">x</p></article>';

const original = {
  argv: process.argv,
  exitCode: process.exitCode,
  stdin: process.stdin,
  stdoutWrite: process.stdout.write.bind(process.stdout),
  stderrWrite: process.stderr.write.bind(process.stderr),
  debug: process.env["HR_DEBUG"],
};

/** 每个用例都要"首次求值" `main.ts`（它有顶层副作用），所以用查询串绕开模块缓存。 */
const loadMain = (caseName: string): Promise<unknown> =>
  import(/* @vite-ignore */ `../src/main.ts?case=${caseName}`);

const enterShell = (
  stdinChunks: readonly unknown[],
  debug = false,
): { out: () => string; err: () => string } => {
  const out: string[] = [];
  const err: string[] = [];
  let index = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: {
      // 只实现 async iterator：`main.ts` 用 `for await` 消费。
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          const chunk = stdinChunks[index];
          index += 1;
          return Promise.resolve(
            chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk },
          );
        },
      }),
    },
  });
  if (debug) process.env["HR_DEBUG"] = "1";
  else delete process.env["HR_DEBUG"];
  return { out: () => out.join(""), err: () => err.join("") };
};

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = original.argv;
  process.exitCode = original.exitCode;
  Object.defineProperty(process, "stdin", { configurable: true, value: original.stdin });
  process.stdout.write = original.stdoutWrite;
  process.stderr.write = original.stderrWrite;
  if (original.debug === undefined) delete process.env["HR_DEBUG"];
  else process.env["HR_DEBUG"] = original.debug;
});

describe("main.ts · 进程壳", () => {
  it("should run --help and set exitCode 0", async () => {
    const io = enterShell([]);
    process.argv = [process.execPath, "main.ts", "--help"];
    process.exitCode = undefined;

    await loadMain("help");

    expect(process.exitCode).toBe(0);
    expect(io.out()).toContain("hReader CLI");
    expect(io.err()).toBe("");
  });
});

describe("main.ts · 管道与内部错误", () => {
  it("should read --html-stdin chunks through the async iterator", async () => {
    writeFileSync(join(dir, "m1.html"), DOC);
    const io = enterShell([Buffer.from('<p data-hr-id="hr-n">新</p>')]);
    process.argv = [
      process.execPath,
      "main.ts",
      "patch",
      join(dir, "m1.html"),
      "--workspace",
      dir,
      "hr-b",
      "--action",
      "replace",
      "--html-stdin",
      "--json",
    ];
    process.exitCode = undefined;

    await loadMain("stdin");

    expect(process.exitCode).toBe(0);
    expect(io.out()).toContain('"ok":true');
  });
});

describe("main.ts · 非字节 stdin", () => {
  it("should reject a non-byte stdin chunk as an internal error (70)", async () => {
    writeFileSync(join(dir, "m2.html"), DOC);
    const io = enterShell(["字符串不是字节"]);
    process.argv = [
      process.execPath,
      "main.ts",
      "patch",
      join(dir, "m2.html"),
      "--workspace",
      dir,
      "hr-b",
      "--action",
      "replace",
      "--html-stdin",
    ];
    process.exitCode = undefined;

    await loadMain("bad-chunk");

    expect(process.exitCode).toBe(70);
    expect(io.err()).toContain("stdin 片段不是字节");
    expect(io.out()).toBe("");
  });
});

describe("main.ts · HR_DEBUG", () => {
  it("should print the stack when HR_DEBUG=1", async () => {
    writeFileSync(join(dir, "m3.html"), DOC);
    const io = enterShell(["字符串不是字节"], true);
    process.argv = [
      process.execPath,
      "main.ts",
      "patch",
      join(dir, "m3.html"),
      "--workspace",
      dir,
      "hr-b",
      "--action",
      "replace",
      "--html-stdin",
    ];
    process.exitCode = undefined;

    await loadMain("debug");

    expect(process.exitCode).toBe(70);
    expect(io.err()).toContain("at ");
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
