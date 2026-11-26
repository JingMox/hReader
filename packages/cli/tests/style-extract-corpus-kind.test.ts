// This file pins the in-process behavior proof for the `hr style extract`
// corpus kind gate: a non-regular file must be rejected by `stat`'s type
// check, with zero `readFile` calls on the refusal path. The end-to-end
// refusal shape (real subprocess) lives in style-extract-special.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import type * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spies record calls: `stat` answers a real Stats taken from a real special
 * file, `readFile` only counts — if the refusal path did read the corpus
 * (unbounded device, FIFO waiting on a writer), the readFile count proves it.
 */
const spies = vi.hoisted(() => ({
  stat: vi.fn<(path: string) => Promise<Stats>>(),
  readFile: vi.fn<(path: string) => Promise<Uint8Array>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  return { ...actual, stat: spies.stat, readFile: spies.readFile };
});

const { styleExtractCommand } = await import("../src/commands/style-extract");

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-corpus-kind-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const inputOf = (files: readonly string[]) => ({
  files,
  workspace: dir,
  id: "unit",
  name: "单测",
  inheritsVisual: "atelier-editorial",
  out: undefined,
  force: false,
  json: false,
  llm: undefined,
});

/** The spy `stat` answers the real Stats of the given path: the kernel decides the file kind, not the test. */
const statAs = (probe: string): void => {
  const stats = statSync(probe);
  spies.stat.mockImplementation(() => Promise.resolve(stats));
};

const messageOf = async (corpus: string): Promise<string> => {
  try {
    await styleExtractCommand(inputOf([corpus]));
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: "invalid_input" });
    return error instanceof Error ? error.message : "";
  }
  throw new Error("expected a refusal, but the command succeeded");
};

const corpus = join(dir, "corpus.md");

describe("hr style extract · corpus kind gate (stubbed fs)", () => {
  beforeEach(() => {
    spies.stat.mockReset();
    spies.readFile.mockReset();
  });

  it.skipIf(process.platform === "win32")(
    "should refuse a fifo after one stat and never open it for reading",
    async () => {
      const fifo = join(dir, "probe.fifo");
      execFileSync("mkfifo", [fifo]);
      statAs(fifo);

      const message = await messageOf(corpus);

      expect(message).toContain("非普通文件");
      expect(spies.stat).toHaveBeenCalledWith(corpus);
      expect(spies.stat).toHaveBeenCalledTimes(1);
      expect(spies.readFile).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "should refuse a character device behind a symlink after one stat",
    async () => {
      // `stat` follows symlinks: the spy answers /dev/zero's Stats, so the caller still sees "not a regular file".
      statAs("/dev/zero");

      const message = await messageOf(corpus);

      expect(message).toContain("非普通文件");
      expect(spies.stat).toHaveBeenCalledWith(corpus);
      expect(spies.stat).toHaveBeenCalledTimes(1);
      expect(spies.readFile).not.toHaveBeenCalled();
    },
  );

  it("should refuse a directory after one stat and name it a directory", async () => {
    const probe = join(dir, "subdir");
    mkdirSync(probe);
    statAs(probe);

    const message = await messageOf(corpus);

    expect(message).toContain("是目录");
    expect(spies.stat).toHaveBeenCalledWith(corpus);
    expect(spies.stat).toHaveBeenCalledTimes(1);
    expect(spies.readFile).not.toHaveBeenCalled();
  });
});
