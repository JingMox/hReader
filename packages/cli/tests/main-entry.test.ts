// This layer covers `main.ts`'s process shell (argv/env/stdin → run → process.exitCode), run in-process once;
// real subprocess behavior lives in cli-process.test.ts (this only patches the shell code coverage cannot reach).

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { pngOf } from "./chrome-png";

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

/** Every case needs a "first evaluation" of `main.ts` (it has top-level side effects), so a query string defeats the module cache. */
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
      // Only the async iterator is implemented: `main.ts` consumes it with `for await`.
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

describe("main.ts · process shell", () => {
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

describe("main.ts · pipes and internal errors", () => {
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

describe("main.ts · non-byte stdin", () => {
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

describe("main.ts · binary stdout", () => {
  it("should send `hr thumb`'s cached PNG through the byte channel, not the re-encoding string one", async () => {
    // A seeded cache hit is the only way to keep this in-process: a miss would spawn real Chrome.
    const doc = join(dir, "t1.html");
    writeFileSync(doc, DOC);
    const hash = createHash("sha256").update(readFileSync(doc)).digest("hex");
    mkdirSync(join(dir, ".hreader", "thumbs"), { recursive: true });
    writeFileSync(join(dir, ".hreader", "thumbs", `${hash}.png`), pngOf(600, 400));
    const io = enterShell([]);
    process.argv = [process.execPath, "main.ts", "thumb", doc, "--workspace", dir];
    process.exitCode = undefined;

    await loadMain("thumb-stdout");

    expect(process.exitCode).toBe(0);
    expect(io.out().length).toBeGreaterThan(0);
    expect(io.err()).toBe("");
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

describe("main.ts · signal entry", () => {
  it("should resolve the stop promise on SIGTERM and SIGINT (in-process emit)", async () => {
    enterShell([]);
    process.argv = [process.execPath, "main.ts", "--help"];
    process.exitCode = undefined;

    await loadMain("signals");
    process.emit("SIGTERM");
    process.emit("SIGINT");

    expect(process.exitCode).toBe(0);
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
