// This layer covers `run(["thumb", …])` end-to-end wiring that needs no real
// Chrome: the TTY refusal (exit 1), usage errors (exit 2), the no-Chrome
// pipeline failure (exit 3 with the warn line out and nothing on disk), and
// the binary-vs-text stdout split.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { run, type CliIo } from "../src/run";
import { pngOf } from "./chrome-png";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-thumb-")));
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

const noChrome = { env: { HREADER_CHROME: join(dir, "no-chrome") } };

describe("run · thumb boundary", () => {
  it("should exit 1 with invalid_input when stdout is a TTY and no --out was given", async () => {
    const { io, out, err } = capture({ ...noChrome, isStdoutTty: true });
    expect(await run(["thumb", "img.html"], io)).toBe(1);
    expect(err.join("")).toContain("--out");
    expect(out.join("")).toBe("");
    // The refusal is pre-render: no cache directory may appear as a side effect.
    expect(existsSync(join(dir, ".hreader", "thumbs"))).toBe(false);
  });

  it("should exit 2 on usage errors before any pipeline work", async () => {
    const { io, out, err } = capture({ ...noChrome });
    expect(await run(["thumb"], io)).toBe(2);
    expect(err.join("")).toContain("thumb 缺少 <file>");
    expect(out.join("")).toBe("");
    expect(await run(["thumb", "a.html", "--width", "800"], io)).toBe(2);
  });
});

describe("run · thumb Chrome wiring", () => {
  it("should exit 3 with the warn line out and nothing written when Chrome is missing", async () => {
    const out = join(dir, "a.png");
    const { io, out: stdout, err } = capture({ ...noChrome });
    expect(await run(["thumb", "img.html", "--out", out], io)).toBe(3);
    expect(err.join("")).toContain("已移除 1 个外部图片");
    expect(err.join("")).toContain("找不到 Chrome");
    expect(stdout.join("")).toBe("");
    expect(existsSync(out)).toBe(false);
    // A failed generation writes no cache entry either.
    expect(existsSync(join(dir, ".hreader", "thumbs"))).toBe(false);
  });

  it("should answer --json with the same chrome_missing code on stdout", async () => {
    const { io, out } = capture({ ...noChrome, isStdoutTty: true });
    expect(await run(["thumb", "img.html", "--json"], io)).toBe(3);
    const parsed: unknown = JSON.parse(out.join(""));
    expect(parsed).toMatchObject({ ok: false, code: "chrome_missing" });
  });
});

describe("run · thumb stdout binary", () => {
  it("should reach the renderer in stdout mode (non-TTY, no --out): the pipeline failure is exit 3, not a boundary refusal", async () => {
    const bytes: Uint8Array[] = [];
    const { io, out, err } = capture({ ...noChrome, stdoutBytes: (b) => bytes.push(b) });
    expect(await run(["thumb", "img.html"], io)).toBe(3);
    expect(err.join("")).toContain("找不到 Chrome");
    // The render died before producing bytes: neither channel carries output.
    expect(out.join("")).toBe("");
    expect(bytes).toEqual([]);
  });

  it("should serve a seeded cache hit through the default byte sink when no stdoutBytes channel is injected", async () => {
    // A caller that never wires a byte channel still runs `hr thumb` to a pipe:
    // resolvedIoOf's `() => undefined` sink must swallow the PNG, Chrome-free.
    // Own workspace: sibling cases assert `.hreader` stays absent under `dir`.
    const ws = join(dir, "seeded-hit");
    mkdirSync(join(ws, ".hreader", "thumbs"), { recursive: true });
    const doc = join(ws, "img.html");
    writeFileSync(doc, '<article data-hr-id="hr-i"><p data-hr-id="hr-j">x</p></article>');
    const hash = createHash("sha256").update(readFileSync(doc)).digest("hex");
    writeFileSync(join(ws, ".hreader", "thumbs", `${hash}.png`), pngOf(600, 400));
    const { io, out, err } = capture({ ...noChrome });

    expect(await run(["thumb", doc, "--workspace", ws], io)).toBe(0);
    // A cache hit returns the empty receipt; the PNG left through the byte sink.
    expect(out.join("")).toBe("");
    expect(err.join("")).toBe("");
  });
});

describe("run · thumb io_failure output", () => {
  it("should keep host paths out of stderr and the --json body when the cache dir is not a directory", async () => {
    // `.hreader/thumbs` as a plain file: the PNG read answers ENOTDIR →
    // io_failure — deterministic without chmod (root-runners ignore mode bits).
    const ws = join(dir, "io-leak");
    mkdirSync(join(ws, ".hreader"), { recursive: true });
    writeFileSync(join(ws, ".hreader", "thumbs"), "not a dir");
    const doc = join(ws, "img.html");
    writeFileSync(doc, '<article data-hr-id="hr-i"><p data-hr-id="hr-j">x</p></article>');
    const fragments = ["/Users", "/private", "/tmp", "/var", "/home"];

    const { io, out, err } = capture({ ...noChrome });
    expect(await run(["thumb", doc, "--workspace", ws], io)).toBe(3);
    // The user-facing message names the workspace-relative path only.
    expect(err.join("")).toContain("读取缩略图缓存失败：.hreader/thumbs/");
    for (const fragment of fragments) {
      expect(err.join("")).not.toContain(fragment);
      expect(out.join("")).not.toContain(fragment);
    }

    const { io: jsonIo, out: jsonOut } = capture({ ...noChrome });
    expect(await run(["thumb", doc, "--workspace", ws, "--json"], jsonIo)).toBe(3);
    const body = jsonOut.join("");
    const parsed = JSON.parse(body) as { code?: string; message?: string };
    expect(parsed.code).toBe("io_failure");
    expect(parsed.message).toContain(".hreader/thumbs/");
    for (const fragment of fragments) {
      expect(body).not.toContain(fragment);
    }
  });
});
