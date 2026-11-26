// This layer covers `hr style extract`'s in-process orchestration (real fs + real core): the command function, run()'s downgrade and errors, output shapes.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { extractStyle, type ExtractStyleResult } from "@hreader/core";

import { fileSizeOf, readTextFile } from "../src/input";
import { dataStyleExtract, humanStyleExtract } from "../src/output";
import { run, type CliIo } from "../src/run";
import { styleExtractCommand, type StyleExtractInput } from "../src/commands/style-extract";
import { parseJsonLine } from "./harness";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-extract-")));
mkdirSync(join(dir, "styles"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CORPUS = ["第一段只有一句。", "", "第二段两句。还带一个转折。"].join("\n");

const corpusAt = (name: string, text = CORPUS): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

const inputOf = (
  files: readonly string[],
  overrides: Partial<StyleExtractInput> = {},
): StyleExtractInput => ({
  files,
  workspace: dir,
  id: "unit-style",
  name: "单测风格",
  inheritsVisual: "atelier-editorial",
  out: undefined,
  force: false,
  json: false,
  llm: undefined,
  ...overrides,
});

interface Capture {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

const capture = (
  env: Readonly<Record<string, string | undefined>> = {},
  fetchImpl?: typeof globalThis.fetch,
): Capture => {
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
      env,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    },
  };
};

const rejectionOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : "not-an-error";
  }
  throw new Error("expected a throw, but the call succeeded");
};

describe("styleExtractCommand · printing", () => {
  it("should return the yaml itself when not writing and not json", async () => {
    const text = await styleExtractCommand(inputOf([corpusAt("a.md"), corpusAt("b.md")]));

    expect(text).toContain('id: "unit-style"');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("should wrap stats and yaml with a null path for --json", async () => {
    const text = await styleExtractCommand(inputOf([corpusAt("c.md")], { json: true }));

    expect(parseJsonLine(text)).toMatchObject({
      ok: true,
      data: { path: null, stats: { paragraphs: 2 } },
    });
    expect(text).toContain('"yaml":"id: \\"unit-style\\"');
  });
});

describe("styleExtractCommand · writing to disk", () => {
  it("should print the human summary when writing", async () => {
    const text = await styleExtractCommand(
      inputOf([corpusAt("d.md")], { out: "styles/unit.yaml", json: false }),
    );

    expect(text).toContain("extracted styles/unit.yaml (2 段、3 句");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("should report the written path in --json", async () => {
    const text = await styleExtractCommand(
      inputOf([corpusAt("e.md")], { out: "styles/unit-json.yaml", json: true }),
    );

    expect(parseJsonLine(text)).toMatchObject({
      ok: true,
      data: { path: "styles/unit-json.yaml" },
    });
  });
});

describe("styleExtractCommand · corpus guards", () => {
  it("should refuse an unsupported suffix before reading the file", async () => {
    const message = await rejectionOf(styleExtractCommand(inputOf([join(dir, "gone.txt")])));

    expect(message).toContain(".md / .html");
  });

  it("should refuse one corpus file above 1 MiB", async () => {
    const message = await rejectionOf(
      styleExtractCommand(inputOf([corpusAt("big.md", "一".repeat(400_000))])),
    );

    expect(message).toContain("单篇语料超过 1 MiB");
  });

  it("should refuse a corpus total above 4 MiB", async () => {
    const files = ["t1.md", "t2.md", "t3.md", "t4.md", "t5.md"].map((name) =>
      corpusAt(name, "一".repeat(300_000)),
    );

    const message = await rejectionOf(styleExtractCommand(inputOf(files)));

    expect(message).toContain("语料总量超过 4 MiB");
  });
});

describe("run · style extract downgrade and errors", () => {
  it("should warn once about the missing key and still print the yaml", async () => {
    const { io, out, err } = capture({});

    const code = await run(["style", "extract", corpusAt("r1.md"), "--id", "x", "--name", "x"], io);

    expect(code).toBe(0);
    expect(out.join("")).toContain('id: "x"');
    expect(err.join("")).toContain("未设置 OPENCODE_API_KEY，仅用统计结果");
  });

  it("should bubble the transport llm_failure when a key is present", async () => {
    const { io, out, err } = capture({ OPENCODE_API_KEY: "sk-unit-test" }, () =>
      Promise.resolve(new Response("boom", { status: 500 })),
    );

    const code = await run(["style", "extract", corpusAt("r2.md"), "--json"], io);

    expect(code).toBe(3);
    expect(out.join("")).toContain('"code":"llm_failure"');
    expect(out.join("")).toContain("可加 --no-llm 只用统计结果");
    expect(err.join("")).not.toContain("sk-unit-test");
    expect(out.join("")).not.toContain("sk-unit-test");
  });

  it("should stay quiet about the key with --no-llm", async () => {
    const { io, err } = capture({ OPENCODE_API_KEY: "sk-unit-test" });

    const code = await run(["style", "extract", corpusAt("r3.md"), "--no-llm", "--json"], io);

    expect(code).toBe(0);
    expect(err.join("")).not.toContain("未设置");
  });
});

describe("run · style extract fetch fallback", () => {
  it("should default to an empty env and the global fetch when neither is injected", async () => {
    const out: string[] = [];
    const err: string[] = [];
    // No `env` passed: no key → pure-stats version; this pins the `io.env ?? {}` fallback.
    const code = await run(["style", "extract", corpusAt("r2-nofetch.md"), "--json"], {
      cwd: dir,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
    });

    expect(code).toBe(0);
    expect(err.join("")).toContain("未设置 OPENCODE_API_KEY");
  });

  it("should fall back to the global fetch when the io has no injection point", async () => {
    // A key but no `io.fetch`: real `fetch` runs, pointed at a localhost port that must refuse — never off-machine.
    const { io, out } = capture({
      OPENCODE_API_KEY: "sk-unit-test",
      HR_LLM_BASE_URL: "http://127.0.0.1:9",
    });

    const code = await run(["style", "extract", corpusAt("r2-real-fetch.md"), "--json"], io);

    expect(code).toBe(3);
    expect(out.join("")).toContain('"code":"llm_failure"');
  });
});

describe("run · style extract default-value reminder", () => {
  it("should warn about the defaults it filled in", async () => {
    const { io, err } = capture({});

    const code = await run(["style", "extract", corpusAt("r4.md")], io);

    expect(code).toBe(0);
    expect(err.join("")).toContain("未给 --id，使用默认值：r4");
    expect(err.join("")).toContain("未给 --name，使用默认值：r4");
    expect(err.join("")).toContain("单篇语料的规则会很窄");
  });

  it("should resolve --out against the workspace in-process too", async () => {
    const { io, out } = capture({});

    const code = await run(
      [
        "style",
        "extract",
        corpusAt("r5.md"),
        "--id",
        "x",
        "--name",
        "x",
        "--out",
        "styles/r5.yaml",
        "--json",
      ],
      io,
    );

    expect(code).toBe(0);
    expect(out.join("")).toContain('"path":"styles/r5.yaml"');
  });
});

describe("output and reading helpers", () => {
  it("should stat the byte size without decoding the file", async () => {
    const path = corpusAt("sized.md", "一二。");

    expect(await fileSizeOf(path)).toBe(Buffer.byteLength("一二。", "utf8"));
    expect(await readTextFile(path)).toBe("一二。");
  });

  it("should map a missing path to not_a_file from stat", async () => {
    await expect(fileSizeOf(join(dir, "nope.md"))).rejects.toThrow(/路径不存在/u);
  });

  it("should refuse a directory and name it in the message", async () => {
    const path = join(dir, "dir-corpus.md");
    mkdirSync(path);

    await expect(fileSizeOf(path)).rejects.toThrow(/只能是普通文件：.*是目录/u);
  });

  it.skipIf(process.platform === "win32")("should refuse a character device", async () => {
    // `/dev/zero`'s `size` is 0: an implementation comparing only the cap would allow it, then read unboundedly.
    // Only the `stat` branch is tested here: if `fileSizeOf` changed to read-then-measure, this process would OOM instead of asserting — the device path's main evidence is the subprocess case.
    await expect(fileSizeOf("/dev/zero")).rejects.toThrow(/是.?非普通文件/u);
  });
});

describe("the two output renderings", () => {
  /** `ExtractStyleResult` is produced by core: a realistically shaped object is enough to assert the two renderings. */
  const RESULT: ExtractStyleResult = extractStyle({
    corpus: [{ format: "markdown", text: "一。二。" }],
    id: "unit-style",
    name: "单测风格",
    inheritsVisual: "atelier-editorial",
  });

  it("should render the json shape with and without a path", () => {
    expect(dataStyleExtract(RESULT, null)).toContain('"path":null');
    expect(dataStyleExtract(RESULT, "a.yaml")).toContain('"path":"a.yaml"');
    expect(dataStyleExtract(RESULT, "a.yaml")).toContain(`"yaml":${JSON.stringify(RESULT.yaml)}`);
  });

  it("should render the human summary with the stats inline", () => {
    expect(humanStyleExtract(RESULT, "a.yaml")).toBe(
      `extracted a.yaml (${String(RESULT.stats.paragraphs)} 段、${String(RESULT.stats.sentences)} 句，` +
        `平均句长 ${String(RESULT.stats.averageSentenceChars)} 字，每段 ≤ ${String(RESULT.stats.maxParagraphSentences)} 句)\n`,
    );
  });
});
