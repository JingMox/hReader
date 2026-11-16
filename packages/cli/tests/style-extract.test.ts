// 这层管：`hr style extract` 的真子进程行为（stdout YAML、写盘、错误码、无 key 降级）；不碰网络。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseJsonLine, runCli, withTempDir, type CliResult } from "./harness";

const CORPUS = [
  "第一段只有一句。",
  "",
  "第二段两句。还带一个转折。",
  "",
  "第三段三句。这是第二句。这是第三句。",
  "",
  "## 标题不算段落",
  "",
  "```",
  "代码块也不算。",
  "```",
].join("\n");

/**
 * 用真实文件当语料：`--no-llm` 是这一批唯一可用的路径，所以每个用例都显式给。
 * env 里显式清空 `OPENCODE_API_KEY`：开发机的 shell 往往真有一枚，"有没有 key"必须由用例决定。
 */
const NO_KEY = { OPENCODE_API_KEY: "" };

const seedCorpus = (dir: string): string => {
  const path = join(dir, "corpus.md");
  writeFileSync(path, CORPUS);
  return path;
};

const extract = async (
  args: readonly string[],
  dir: string,
  env: Record<string, string> = NO_KEY,
): Promise<CliResult> => runCli(["style", "extract", "--no-llm", ...args], { cwd: dir, env });

const jsonDataOf = (result: CliResult): unknown => {
  const parsed = parseJsonLine(result.stdout);
  expect(parsed).toMatchObject({ ok: true });
  return parsed;
};

describe("hr style extract · stdout", () => {
  it("should print the yaml to stdout and warn about defaults on stderr", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);

      const result = await extract([file, "--id", "demo", "--name", "示例"], dir);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('id: "demo"');
      expect(result.stdout).toContain("  sentence_rhythm:");
      expect(result.stdout).toContain("  examples: []");
      expect(result.stderr).toContain("未检测到 OPENCODE_API_KEY");
    });
  });

  it("should report stats and a null path in --json mode when only printing", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);

      const result = await extract([file, "--id", "demo", "--json"], dir);

      expect(result.code).toBe(0);
      expect(jsonDataOf(result)).toMatchObject({
        data: { path: null, stats: { paragraphs: 3, sentences: 6 } },
      });
      expect(result.stdout).toContain('"yaml":"id: \\"demo\\"');
    });
  });
});

describe("hr style extract · 单篇提醒", () => {
  it("should warn when only one corpus file is given", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);

      const result = await extract([file, "--id", "demo"], dir);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("单篇");
    });
  });
});

describe("hr style extract · 写盘", () => {
  it("should write the file and print a one-line summary with --out", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);
      mkdirSync(join(dir, "styles"));

      const result = await extract([file, "--id", "demo", "--out", "styles/demo.yaml"], dir);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("extracted styles/demo.yaml");
      expect(result.stdout).toContain("3 段");
      const written = readFileSync(join(dir, "styles/demo.yaml"), "utf8");
      expect(written).toContain('id: "demo"');
      expect(written.endsWith("\n")).toBe(true);
    });
  });
});

describe("hr style extract · 覆盖守卫", () => {
  it("should keep an existing file intact without --force, then overwrite with it", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);
      mkdirSync(join(dir, "styles"));
      writeFileSync(join(dir, "styles/demo.yaml"), "旧内容");

      const refused = await extract(
        [file, "--id", "demo", "--out", "styles/demo.yaml", "--json"],
        dir,
      );
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain('"code":"file_exists"');
      expect(readFileSync(join(dir, "styles/demo.yaml"), "utf8")).toBe("旧内容");

      const forced = await extract(
        [file, "--id", "demo", "--out", "styles/demo.yaml", "--force"],
        dir,
      );
      expect(forced.code).toBe(0);
      expect(readFileSync(join(dir, "styles/demo.yaml"), "utf8")).toContain('id: "demo"');
    });
  });

  it("should refuse a missing parent directory instead of creating it", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);

      const result = await extract(
        [file, "--id", "demo", "--out", "nope/demo.yaml", "--json"],
        dir,
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"code":"invalid_input"');
      expect(existsSync(join(dir, "nope"))).toBe(false);
    });
  });
});

describe("hr style extract · --out 边界", () => {
  it("should refuse --out outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);

      const result = await extract([file, "--out", "../escape.yaml", "--json"], dir);

      expect(result.code).toBe(3);
      expect(result.stdout).toContain('"code":"path_outside_workspace"');
    });
  });
});

describe("hr style extract · 语料边界", () => {
  it("should reject an unsupported corpus format", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "corpus.txt");
      writeFileSync(path, CORPUS);

      const result = await extract([path, "--json"], dir);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"code":"invalid_input"');
      expect(result.stdout).toContain(".md / .html");
    });
  });

  it("should reject corpus that is not valid UTF-8", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "corpus.md");
      writeFileSync(path, Uint8Array.from([0x2d, 0xff, 0xfe, 0x0a]));

      const result = await extract([path, "--json"], dir);

      expect(result.code).toBe(3);
      expect(result.stdout).toContain('"code":"invalid_utf8"');
    });
  });
});

describe("hr style extract · 语料与 id 上限", () => {
  it("should reject a corpus file above 1 MiB before decoding it", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "big.md");
      writeFileSync(path, "一".repeat(400_000));

      const result = await extract([path, "--json"], dir);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("单篇语料超过 1 MiB");
    });
  });

  it("should reject a style id that the strict parser refuses", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);

      const result = await extract([file, "--id", "Bad Id", "--json"], dir);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"code":"invalid_style"');
    });
  });
});

describe("hr style extract · LLM 开关", () => {
  it("should refuse to run the LLM path when a key is present, in this build", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);

      const result = await runCli(["style", "extract", file, "--json"], {
        cwd: dir,
        env: { OPENCODE_API_KEY: "sk-test-never-used" },
      });

      expect(result.code).toBe(3);
      expect(result.stdout).toContain('"code":"llm_failure"');
      expect(result.stdout).not.toContain("sk-test-never-used");
      expect(result.stderr).not.toContain("sk-test-never-used");
    });
  });

  it("should stay quiet about the missing key when --no-llm is explicit", async () => {
    await withTempDir(async (dir) => {
      const file = seedCorpus(dir);

      const result = await runCli(
        ["style", "extract", file, "--id", "demo", "--no-llm", "--json"],
        {
          cwd: dir,
          env: { OPENCODE_API_KEY: "sk-test-never-used" },
        },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("未检测到");
    });
  });
});
