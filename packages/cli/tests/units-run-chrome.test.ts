// 这层管：`run(["pdf"|"png", …])` 把 stop/env 接进渲染层，以及"找不到 Chrome"时的退出码与 stderr。

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

describe("run · pdf/png 的 Chrome 接线", () => {
  // 只走到"选 Chrome 二进制"这一步就失败：命令层到会话层的整条接线被执行到，但不真的起进程。
  const noChrome = { env: { HREADER_CHROME: join(dir, "no-chrome") } };

  // 用 `img.html`：`printProductOf` 在渲染之前就发警告，顺带把 stderr 的 warn 接线也走一遍。
  it.each([
    ["pdf", ["img.html", "--out", join(dir, "a.pdf")], join(dir, "a.pdf")],
    ["png", ["img.html", "--out", join(dir, "a.png"), "--width", "800"], join(dir, "a.png")],
  ])("%s 找不到 Chrome 时 exit 3、警告已出、不落盘", async (kind, argv, out) => {
    // `stop` 给上：pdf/png 也必须把它接进渲染层（不传就等满 --timeout，Ctrl-C 会白等）。
    const stop = new Promise<void>(() => undefined);
    const { io, out: stdout, err } = capture({ ...noChrome, stop });
    expect(await run([kind, ...argv], io)).toBe(3);
    expect(err.join("")).toContain("已移除 1 个外部图片");
    expect(err.join("")).toContain("找不到 Chrome");
    expect(err.join("")).toContain("候选路径：");
    expect(stdout.join("")).toBe("");
    expect(existsSync(out)).toBe(false);
  });
});
