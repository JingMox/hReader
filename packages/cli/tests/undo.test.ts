// This layer covers `hr undo` — arguments, exit codes, both outputs, and a real-subprocess "change once, undo once".
// `undo` is the only new writable command on the CLI side, previously zero-covered (50% dead code in src) — filled in here.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dataUndo, humanUndo } from "../src/output";
import { run, type CliIo } from "../src/run";
import { checked, DOC, seed, sha } from "./cli-support";
import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";

interface Capture {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

const capture = (cwd: string): Capture => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
    },
  };
};

const patchOf = (path: string): readonly string[] => [
  "patch",
  path,
  "hr-c",
  "--action",
  "replace",
  "--html",
  "<p>改过的正文</p>",
];

describe("hr undo · arguments", () => {
  it("should reject a missing <file> with exit 2 and the undo synopsis", async () => {
    const { io, out, err } = capture(process.cwd());
    const code = await run(["undo"], io);

    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("undo 缺少 <file>");
    expect(err.join("")).toContain("hr undo <file>");
  });

  it("should reject a second positional argument", async () => {
    const { io, err } = capture(process.cwd());
    const code = await run(["undo", "a.html", "b.html"], io);

    expect(code).toBe(2);
    expect(err.join("")).toContain("undo 只接受 1 个位置参数，多出 1 个");
  });

  it("should reject a flag that undo does not accept", async () => {
    const { io, err } = capture(process.cwd());
    const code = await run(["undo", "a.html", "--selector", "h2"], io);

    expect(code).toBe(2);
    expect(err.join("")).toContain("--selector");
  });
});

describe("hr undo · real disk and output", () => {
  it("should keep the file and report nothing_to_undo when there is no history", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);
      const before = sha(path);
      const { io, out, err } = capture(dir);

      const code = await run(["undo", "a.html"], io);

      expect(code).toBe(1);
      expect(err.join("")).toContain("没有可撤销的历史快照");
      expect(out).toEqual([]);
      expect(sha(path)).toBe(before);
    });
  });
});

describe("hr undo · output and history", () => {
  it("should print the human line after an undo", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const { io, out } = capture(dir);

      expect(await run(patchOf("a.html"), io)).toBe(0);
      out.length = 0;
      expect(await run(["undo", "a.html"], io)).toBe(0);

      expect(out.join("")).toMatch(/^undone .*a\.html \(\d+ bytes, from .+\)\n$/u);
    });
  });

  it("should print the JSON envelope when --json is given", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const { io, out } = capture(dir);

      expect(await run(patchOf("a.html"), io)).toBe(0);

      out.length = 0;
      expect(await run(["undo", "a.html", "--json"], io)).toBe(0);

      // Key order is the contract (envelope `ok`→`data`, inside data the `dataUndo` field order): one regex pins both the envelope and the inner layer.
      const line = out.join("").trimEnd();
      expect(line).toMatch(
        /^\{"ok":true,"data":\{"path":"[^"]+a\.html","bytes":\d+,"restoredFrom":".+","sha256":"[0-9a-f]{64}"\}\}$/u,
      );
      // `sha256` must be the hash of "the on-disk bytes after restore": one digit off and undo did not really write the old bytes back.
      expect(out.join("")).toContain(`"sha256":"${sha(join(dir, "a.html"))}"`);
    });
  });
});

describe("hr undo · real subprocess", () => {
  it("should restore the exact bytes of the previous revision", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const before = sha(join(dir, "a.html"));
      checked(await runCli(patchOf("a.html"), { cwd: dir }));
      expect(sha(join(dir, "a.html"))).not.toBe(before);

      const result = checked(await runCli(["undo", "a.html"], { cwd: dir }));

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^undone .*a\.html \(\d+ bytes, from .+\)\n$/u);
      expect(sha(join(dir, "a.html"))).toBe(before);
    });
  });

  it("should exit non-zero and keep the file when undo runs on a file with no history", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "plain.html");
      writeFileSync(path, DOC);
      const before = sha(path);

      const result = checked(await runCli(["undo", "plain.html"], { cwd: dir }));

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("没有可撤销的历史快照");
      expect(sha(path)).toBe(before);
    });
  });
});

describe("undo's output format (pure functions)", () => {
  const result = { path: "/w/a.html", bytes: 12, restoredFrom: "r1", sha256: "abc" };

  it("should render the human line with path, bytes and source revision", () => {
    expect(humanUndo(result)).toBe("undone /w/a.html (12 bytes, from r1)\n");
  });

  it("should wrap the four data keys in the ok envelope, in contract order", () => {
    const line = dataUndo(result);
    const envelope = parseJsonLine(line);

    expect(keysOf(envelope)).toEqual(["ok", "data"]);
    expect(fieldOf(envelope, "ok")).toBe(true);
    // The envelope's inner key order is the contract (`dataUndo`'s field order): one toEqual pins order and all four fields.
    expect(keysOf(fieldOf(envelope, "data"))).toEqual(["path", "bytes", "restoredFrom", "sha256"]);
    // All `--json` output ends with a newline (line-oriented consumers: `head -1` / `readline` never handle half lines).
    expect(line.endsWith("\n")).toBe(true);
  });
});
