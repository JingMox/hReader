// This layer covers the `--json` contract, pipes/encoding, and a deep-nesting regression (all real subprocesses).

import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";
import { checked, seed, sha } from "./cli-support";

describe("--json contract", () => {
  it("should keep the frozen key order for patch and expose historyPath", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(
          // The target is the container <article>: a paragraph is inside its content model (appending one to <p> is refused, but that is another case's job).
          ["patch", "a.html", "hr-a", "--action", "append", "--html", "<p>x</p>", "--json"],
          { cwd: dir },
        ),
      );

      expect(result.code).toBe(0);
      const envelope = parseJsonLine(result.stdout);
      expect(keysOf(envelope)).toEqual(["ok", "data"]);
      expect(keysOf(fieldOf(envelope, "data"))).toEqual([
        "path",
        "bytes",
        "newIds",
        "changed",
        "historyPath",
      ]);
    });
  });
});

describe("--json single-line contract", () => {
  it("should emit exactly one newline even when the tone prompt is multi-line", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(["style", "a.html", "--tone", "atelier-editorial", "--json"], { cwd: dir }),
      );

      expect(result.code).toBe(0);
      const envelope = parseJsonLine(result.stdout);
      expect(keysOf(fieldOf(envelope, "data"))).toEqual(["prompt"]);
      expect(fieldOf(fieldOf(envelope, "data"), "prompt")).toContain("\n");
    });
  });

  // One channel only: `--json` consumers often take `2>&1` as ground truth; a second stderr write adds a stray segment.
  it("should write a parseable error JSON to stdout and nothing to stderr", async () => {
    const result = checked(await runCli(["outline", "missing.html", "--json"]));

    expect(result.code).toBe(3);
    const envelope = parseJsonLine(result.stdout);
    expect(keysOf(envelope)).toEqual(["ok", "code", "message"]);
    expect(fieldOf(envelope, "ok")).toBe(false);
    expect(fieldOf(envelope, "message")).toContain("读取时路径不存在");
    expect(result.stderr).toBe("");
  });
});

describe("pipes and encoding · success path", () => {
  it("should read the fragment from a real pipe", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(["patch", "a.html", "hr-c", "--action", "replace", "--html-stdin", "--json"], {
          cwd: dir,
          stdin: Buffer.from('<p data-hr-id="hr-c">管道</p>'),
        }),
      );

      expect(result.code).toBe(0);
      expect(readFileSync(join(dir, "a.html"), "utf8")).toContain("管道");
    });
  });
});

describe("pipes and encoding · refusal path", () => {
  it("should exit 2 for empty stdin", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], {
          cwd: dir,
          stdin: new Uint8Array(),
        }),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--html-stdin 读到的内容为空");
    });
  });
});

describe("pipes and encoding · UTF-8 refusal", () => {
  it("should reject invalid UTF-8 stdin with exit 3 and keep the target bytes", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const path = seed(dir);
      const before = sha(path);
      const result = checked(
        await runCli(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin", "--json"], {
          cwd: dir,
          stdin: Buffer.from([0xff, 0xfe]),
        }),
      );

      expect(result.code).toBe(3);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: false, code: "invalid_utf8" });
      expect(sha(path)).toBe(before);
    });
  });

  it("should reject invalid UTF-8 --html-file with exit 3", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const path = seed(dir);
      writeFileSync(join(dir, "frag.bin"), Buffer.from([0x3c, 0xff]));
      const before = sha(path);
      const result = checked(
        await runCli(["patch", "a.html", "hr-c", "--action", "append", "--html-file", "frag.bin"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(3);
      expect(result.stderr).toContain("不是合法 UTF-8");
      expect(sha(path)).toBe(before);
    });
  });
});

describe("deep-nesting regression (40k levels do not crash)", () => {
  // `div` is in `ADDRESSABLE_TAGS`, so "no div has an id" = this doc is not normalized yet (`assertNormalized`).
  // So write 40k levels to disk + run `normalize --write`, then outline: both halves are live iteration/serialization stress points.
  it("should normalize and outline a 40000-deep document without crashing", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const deep = `<article>${"<div>".repeat(40_000)}x${"</div>".repeat(40_000)}</article>`;
      writeFileSync(join(dir, "deep.html"), deep);

      const normalized = checked(await runCli(["normalize", "deep.html", "--write"], { cwd: dir }));
      expect(normalized.code).toBe(0);
      // Every div (plus the outermost article itself) must get an id: one missing means deep recursion silently stopped somewhere.
      expect(normalized.stdout).toContain("+40001 ids");

      const result = checked(await runCli(["outline", "deep.html", "--json"], { cwd: dir }));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: true });
    }, 30_000);
  });
});
