// This layer covers `run()`'s write-command path resolution (realpathThroughAncestors) and human output branches; no arg parsing.
//
// The key point: `--workspace` / the target may not exist yet — path resolution must retreat to the deepest existing ancestor and never create directories.

import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_IO, EXIT_OK, EXIT_USAGE } from "../src/exit-codes";
import { run, type CliIo } from "../src/run";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-runpaths-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DOC = '<article data-hr-id="hr-a"><p data-hr-id="hr-b">x</p></article>';

/** A fake io recording stdout/stderr; stdin is always empty (these cases never pass `--html-stdin`). */
const ioAt = (): { io: CliIo; out: () => string; err: () => string } => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      cwd: dir,
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
};

describe("run · path resolution for missing target / missing workspace", () => {
  it("should walk up to the deepest existing ancestor for a missing nested target", async () => {
    const { io, err } = ioAt();
    const code = await run(["patch", "missing/deep.html", "hr-a", "--action", "delete"], io);

    expect(code).toBe(EXIT_IO);
    expect(err()).toContain("realpath时路径不存在");
    expect(readdirSync(dir).includes("missing")).toBe(false);
  });

  it("should reject a missing workspace as a usage error without creating it", async () => {
    const { io, err } = ioAt();
    const ghost = join(dir, "ghost-workspace");
    const code = await run(
      ["patch", "doc.html", "hr-a", "--workspace", ghost, "--action", "delete"],
      io,
    );

    expect(code).toBe(EXIT_USAGE);
    expect(err()).toContain(`--workspace 不存在：${ghost}`);
    expect(readdirSync(dir).includes("ghost-workspace")).toBe(false);
  });
});

describe("run · outline flags (exit 1 and nothing on disk)", () => {
  it("should reject --outline with --no-outline as invalid_input without writing", async () => {
    writeFileSync(join(dir, "conflict.html"), DOC);
    const { io, err } = ioAt();
    const code = await run(
      ["pdf", "conflict.html", "--out", "conflict.pdf", "--outline", "--no-outline"],
      io,
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(err()).toContain("--outline 与 --no-outline 不能同时使用");
    expect(existsSync(join(dir, "conflict.pdf"))).toBe(false);
  });

  it("should reject --no-outline on hr png as invalid_input without writing", async () => {
    writeFileSync(join(dir, "noline.html"), DOC);
    const { io, err } = ioAt();
    const code = await run(["png", "noline.html", "--out", "noline.png", "--no-outline"], io);

    expect(code).toBe(EXIT_FAILURE);
    expect(err()).toContain("hr png 不支持 --no-outline");
    expect(existsSync(join(dir, "noline.png"))).toBe(false);
  });
});

describe("run · style human output", () => {
  it("should print the unchanged line for an already-styled document", async () => {
    writeFileSync(join(dir, "human.html"), DOC);
    const first = ioAt();
    const applied = await run(
      ["style", "human.html", "--visual", "atelier-editorial", "--json"],
      first.io,
    );
    const second = ioAt();
    const code = await run(["style", "human.html", "--visual", "atelier-editorial"], second.io);

    expect(applied).toBe(EXIT_OK);
    expect(code).toBe(EXIT_OK);
    expect(second.out()).toMatch(/^unchanged .*human\.html \(\d+ bytes，主题已与文档里的/u);
    expect(second.err()).toBe("");
  });
});
