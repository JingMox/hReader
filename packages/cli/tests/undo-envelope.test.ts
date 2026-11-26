// This layer covers `hr undo`'s **envelope and empty state**.
//
// Two user-visible facts:
//   1. With history, undo really rolls the content back and `--json` gives `{path,bytes,restoredFrom,sha256}`;
//   2. With no history it is a **readable empty state** (`nothing_to_undo`, exit 1) — not a crash, not a silent success.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, textOf, withTempDir, type CliResult } from "./harness";

const DOC = [
  '<!doctype html><html><body><article data-hr-id="hr-0">',
  '<h1 data-hr-id="hr-a">章标题</h1><p data-hr-id="hr-b">会被删掉的正文。</p>',
  "</article></body></html>",
  "",
].join("\n");

const seed = (dir: string): string => {
  const path = join(dir, "d.html");
  writeFileSync(path, DOC);
  return path;
};

const undo = (dir: string, json = false): Promise<CliResult> =>
  runCli(json ? ["undo", "d.html", "--json"] : ["undo", "d.html"], { cwd: dir });

describe("hr undo · empty state", () => {
  it("should report nothing_to_undo (exit 1) when there is no snapshot", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);

      const human = checked(await undo(dir));
      const json = checked(await undo(dir, true));
      const envelope = parseJsonLine(json.stdout);

      expect(human.code).toBe(1);
      expect(human.stdout).toBe("");
      expect(human.stderr.trim()).toBe("没有可撤销的历史快照");
      expect(json.code).toBe(1);
      expect(fieldOf(envelope, "ok")).toBe(false);
      expect(fieldOf(envelope, "code")).toBe("nothing_to_undo");
      // The empty state must not touch the file.
      expect(readFileSync(path, "utf8")).toBe(DOC);
    });
  });
});

describe("hr undo · rolling back the last change", () => {
  it("should restore the exact previous bytes and hand the snapshot path back", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);
      checked(
        await runCli(["patch", "d.html", "hr-b", "--action", "delete", "--json"], { cwd: dir }),
      );
      expect(readFileSync(path, "utf8")).not.toContain("会被删掉的正文");

      const result = checked(await undo(dir, true));
      const envelope = parseJsonLine(result.stdout);
      const data = fieldOf(envelope, "data");

      expect(result.code).toBe(0);
      expect(fieldOf(envelope, "ok")).toBe(true);
      // After undo the doc is byte-exactly what it was before the patch (the copy in the user's hand/editor).
      expect(readFileSync(path, "utf8")).toBe(DOC);
      expect(fieldOf(data, "bytes")).toBe(Buffer.byteLength(DOC));
      expect(textOf(fieldOf(data, "sha256"))).toMatch(/^[0-9a-f]{64}$/u);
      expect(textOf(fieldOf(data, "restoredFrom"))).toContain(".hreader/history/");
    });
  });
});

describe("hr undo · nothing left to undo on the second run", () => {
  it("should be undoable only once per snapshot, then say nothing_to_undo", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      checked(await runCli(["patch", "d.html", "hr-b", "--action", "delete"], { cwd: dir }));

      expect(checked(await undo(dir)).code).toBe(0);
      const second = checked(await undo(dir));

      expect(second.code).toBe(1);
      expect(second.stderr).toContain("没有可撤销的历史快照");
    });
  });
});

describe("hr undo · human receipt", () => {
  it("should print a one-line human receipt naming the file and its size", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      checked(await runCli(["patch", "d.html", "hr-b", "--action", "delete"], { cwd: dir }));

      const result = checked(await undo(dir));

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^undone .*d\.html \(\d+ bytes, from .+\)\n$/u);
    });
  });
});
