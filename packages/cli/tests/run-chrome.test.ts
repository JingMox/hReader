// This layer covers `run(["pdf"|"png", …])` wiring stop/env into the render layer, plus the exit code and stderr when Chrome cannot be found.

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run, type CliIo } from "../src/run";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-chrome-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

writeFileSync(
  join(dir, "img.html"),
  '<article data-hr-id="hr-i"><h2 data-hr-id="hr-j">图</h2><p data-hr-id="hr-k">正文</p><img src="https://cdn.example/a.png" alt="外链"></article>',
);

const capture = (overrides: Partial<CliIo> = {}): { io: CliIo; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd: dir,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
      home: dir,
      ...overrides,
    },
  };
};

describe("run · pdf/png Chrome wiring", () => {
  // It fails as early as "pick the Chrome binary": the whole command→session wiring ran, but no process really starts.
  const noChrome = { env: { HREADER_CHROME: join(dir, "no-chrome") } };

  // `img.html` is used: `printProductOf` warns before rendering, exercising the stderr warn wiring along the way.
  it.each([
    ["pdf", ["img.html", "--out", join(dir, "a.pdf")], join(dir, "a.pdf")],
    ["png", ["img.html", "--out", join(dir, "a.png"), "--width", "800"], join(dir, "a.png")],
  ])(
    "should exit 3 with the warning already out and nothing on disk when %s finds no Chrome",
    async (kind, argv, out) => {
      // `stop` is supplied: pdf/png must wire it into the render layer too (without it, Ctrl-C waits out the full --timeout).
      const stop = new Promise<void>(() => undefined);
      const { io, out: stdout, err } = capture({ ...noChrome, stop });
      expect(await run([kind, ...argv], io)).toBe(3);
      expect(err.join("")).toContain("已移除 1 个外部图片");
      expect(err.join("")).toContain("找不到 Chrome");
      expect(err.join("")).toContain("候选路径：");
      expect(stdout.join("")).toBe("");
      expect(existsSync(out)).toBe(false);
    },
  );
});
