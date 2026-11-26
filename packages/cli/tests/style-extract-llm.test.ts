// 这层管：`hr style extract` 的 LLM 全链路（真 fixture 回放、判据、不泄漏、两条降级路径）与请求构造
//（"确定性失败不花钱"：前置校验在模型调用之前）。网络用假 fetch 回放 `fixtures/llm/`，零真实调用。

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
import { extractStyleWithLlm } from "@hreader/core";
import type { CorpusText } from "@hreader/core";
import { run, type CliIo } from "../src/run";
import { fetchBodyOf, fetchUrlOf } from "./harness";
import type { LlmPort } from "../src/llm/client";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-llm-")));
mkdirSync(join(dir, "styles"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FIXTURES = join(import.meta.dirname, "../../../fixtures/llm");

const fixtureOf = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const CORPUS = [
  "第一段只有一句。",
  "",
  "第二段两句。还带一个转折。",
  "",
  "第三段三句。这是第二句。这是第三句。",
].join("\n");

const corpusAt = (name: string): string => {
  const path = join(dir, name);
  writeFileSync(path, CORPUS);
  return path;
};

const CANARY = "sk-test-LEAKCANARY";

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** 假 fetch = 回放一份真响应的 body；`status` 用来造非 2xx。 */
const replayOf =
  (body: string, status = 200): typeof globalThis.fetch =>
  () =>
    Promise.resolve(new Response(body, { status }));

const capture = async (
  argv: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly fetch?: typeof globalThis.fetch;
  } = {},
): Promise<Run> => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd: dir,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(new Uint8Array()),
    debug: false,
    launchParentPid: process.ppid,
    env: options.env ?? {},
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const code = await run(argv, io);
  return { code, out: out.join(""), err: err.join("") };
};

const llmRun = async (
  files: readonly string[],
  fetch: typeof globalThis.fetch,
  extra: readonly string[] = [],
): Promise<Run> =>
  capture(["style", "extract", ...files, ...extra], {
    env: { OPENCODE_API_KEY: CANARY },
    fetch,
  });

describe("style extract · 真 fixture 回放", () => {
  it("should eat the recorded body end to end and write the merged yaml", async () => {
    const out = join(dir, "styles/replay.yaml");

    const result = await llmRun(
      [corpusAt("replay.md"), "--id", "replay", "--out", out],
      replayOf(fixtureOf("ok.json")),
    );

    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('id: "replay"');
    expect(result.err).not.toContain("LEAKCANARY");
  });

  it("should carry the recorded persona into the printed yaml", async () => {
    const result = await llmRun(
      [corpusAt("replay-stdout.md"), "--id", "replay"],
      replayOf(fixtureOf("ok.json")),
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain('id: "replay"');
    expect(result.out).toContain("工程笔记");
  });

  it("should merge the recorded body that carries exactly one dropped field", async () => {
    const file = corpusAt("dropped.md");

    const result = await llmRun([file, "--id", "dropped"], replayOf(fixtureOf("dropped.json")));

    expect(result.code).toBe(0);
    expect(result.out).toContain('id: "dropped"');
    expect(result.out).toContain("persona");
  });
});

describe("style extract · 围栏", () => {
  it("should treat the ```json fence as pure formatting noise", async () => {
    const corpus: readonly CorpusText[] = [{ format: "markdown", text: CORPUS }];
    const input = { corpus, id: "fence", name: "围栏", inheritsVisual: "atelier-editorial" };
    const portOf = (body: string): LlmPort => ({ complete: () => Promise.resolve(body) });

    const bare = await extractStyleWithLlm({ ...input, llm: portOf(fixtureOf("ok.json")) });
    const fenced = await extractStyleWithLlm({ ...input, llm: portOf(fixtureOf("fenced.json")) });

    expect(fenced.spec).toEqual(bare.spec);
    expect(fenced.dropped).toEqual(bare.dropped);
    // 同一份 content，只有围栏那两行不同：`parseJsonOf` 若开始裁剪围栏内内容，这里立刻红。
    expect(fenced.spec.language.persona).toBe(bare.spec.language.persona);
  });
});

describe("style extract · 零可用字段即失败", () => {
  it("should fail on zero usable fields and leave --out untouched", async () => {
    const file = corpusAt("r23.md");
    const out = join(dir, "styles/r23.yaml");

    const result = await llmRun(
      [file, "--out", out],
      replayOf('{"choices":[{"message":{"content":"{}"}}]}'),
    );

    expect(result.code).toBe(3);
    expect(result.err).toContain("模型没有返回可用的风格建议");
    expect(result.err).toContain("可加 --no-llm 只用统计结果");
    expect(existsSync(out)).toBe(false);
  });

  it("should keep the code in --json error output", async () => {
    const result = await llmRun([corpusAt("r23-json.md"), "--json"], replayOf('{"foo":1}'));

    expect(result.code).toBe(3);
    expect(result.out).toContain('{"ok":false,"code":"llm_failure"');
    expect(result.out.split("\n").filter((line) => line !== "")).toHaveLength(1);
  });
});

describe("style extract · 非 llm_failure 不加工", () => {
  it("should let a statistic-layer failure through without the --no-llm hint", async () => {
    const result = await llmRun(
      [corpusAt("bad-id.md"), "--id", "a b"],
      replayOf(fixtureOf("ok.json")),
    );

    expect(result.code).not.toBe(3);
    expect(result.err).toContain("id 必须匹配");
    expect(result.err).not.toContain("--no-llm 只用统计结果");
  });
});

describe("style extract · 两条降级路径", () => {
  it("should produce the statistic-only yaml with --no-llm and without a key", async () => {
    const file = corpusAt("degrade.md");
    const byFlag = await capture(["style", "extract", file, "--id", "d", "--no-llm"], {
      env: { OPENCODE_API_KEY: CANARY },
    });
    const withoutKey = await capture(["style", "extract", file, "--id", "d"]);

    expect(byFlag.code).toBe(0);
    expect(withoutKey.code).toBe(0);
    expect(byFlag.out).toBe(withoutKey.out);
    expect(withoutKey.err).toContain("未设置 OPENCODE_API_KEY，仅用统计结果");
    expect(byFlag.err).not.toContain("未设置");
  });
});

describe("style extract · 不泄漏", () => {
  const bodies = ["", "<html>", '{"choices":[]}', '{"choices":[{"message":{"content":"{}"}}]}'];

  it("should keep the key out of every error surface", async () => {
    const file = corpusAt("leak.md");
    for (const body of bodies) {
      const result = await llmRun([file, "--json"], replayOf(body, body === "" ? 500 : 200));
      expect(`${result.out}${result.err}`).not.toContain("LEAKCANARY");
      expect(result.out).toContain('"code":"llm_failure"');
    }
  });
});

describe("style extract · --json 的 dropped", () => {
  it("should expose the dropped entries and omit the key without llm", async () => {
    const merged = await llmRun(
      [corpusAt("json-dropped.md"), "--json"],
      replayOf(fixtureOf("dropped.json")),
    );
    const statOnly = await capture(["style", "extract", corpusAt("json-stat.md"), "--json"]);

    expect(merged.code).toBe(0);
    expect(merged.out).toContain('"dropped":[{"field":"forbidden","reason":"too_long"}]');
    // 纯统计版没进过模型：凭空一个空数组会让用户以为模型看过但什么都没丢。
    expect(statOnly.out).not.toContain('"dropped"');
  });
});

describe("style extract · 失败时不动已有产物", () => {
  it("should keep an existing --out byte for byte when the llm fails", async () => {
    // `--force`：覆盖守卫已放行，这里钉的是"失败不截断"（写盘必须发生在拿到可用产物之后）。
    const out = join(dir, "styles/keep.yaml");
    writeFileSync(out, 'id: "keep"\n');

    const result = await llmRun(
      [corpusAt("keep.md"), "--out", out, "--force"],
      replayOf('{"choices":[{"message":{"content":"{}"}}]}'),
    );

    expect(result.code).toBe(3);
    expect(readFileSync(out, "utf8")).toBe('id: "keep"\n');
  });
});
describe("style extract · --model / --base-url", () => {
  it("should put both flags into the request url and body", async () => {
    const sent: { url: string; body: string }[] = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      sent.push({ url: fetchUrlOf(input), body: fetchBodyOf(init) });
      return Promise.resolve(new Response(fixtureOf("ok.json")));
    };

    const result = await llmRun(
      [corpusAt("flags.md"), "--model", "flag-model", "--base-url", "https://proxy.test/v1"],
      fetch,
    );

    expect(result.code).toBe(0);
    expect(sent[0]?.url).toBe("https://proxy.test/v1/chat/completions");
    expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({ model: "flag-model" });
  });
});

describe("style extract · base url 归一", () => {
  it("should normalize the trailing slash of a flag base url", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (input) => {
      urls.push(fetchUrlOf(input));
      return Promise.resolve(new Response(fixtureOf("ok.json")));
    };

    for (const baseUrl of ["https://proxy.test/v1/", "https://proxy.test/v1"]) {
      const result = await llmRun([corpusAt("slash.md"), "--base-url", baseUrl], fetch);
      expect(result.code).toBe(0);
    }

    expect(urls).toEqual([
      "https://proxy.test/v1/chat/completions",
      "https://proxy.test/v1/chat/completions",
    ]);
  });

  it("should reject a non absolute http(s) base url without spending a call", async () => {
    let sent = 0;
    const fetch: typeof globalThis.fetch = () => {
      sent += 1;
      return Promise.resolve(new Response(fixtureOf("ok.json")));
    };

    for (const baseUrl of ["", "v1", "::bad", "ftp://x/v1"]) {
      const result = await llmRun([corpusAt("empty-url.md"), "--base-url", baseUrl], fetch);
      expect(result.code).toBe(1);
      expect(result.err).toContain("base url 必须是 http(s) 绝对地址");
    }
    expect(sent).toBe(0);
  });
});

const fetchCallsOf = (): { calls: () => number; fetch: typeof globalThis.fetch } => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(new Response(fixtureOf("ok.json")));
  };
  return { calls: () => calls, fetch };
};

describe("style extract · --out 覆盖守卫不花钱", () => {
  it("should refuse an existing --out before calling the model", async () => {
    const out = join(dir, "styles/exists.yaml");
    writeFileSync(out, 'id: "exists"\n');
    const counter = fetchCallsOf();

    const result = await llmRun([corpusAt("exists.md"), "--out", out], counter.fetch);

    expect(result.code).toBe(1);
    expect(result.err).toContain("目标已存在");
    expect(counter.calls()).toBe(0);
    expect(readFileSync(out, "utf8")).toBe('id: "exists"\n');
  });

  it("should still overwrite with --force", async () => {
    const out = join(dir, "styles/forced.yaml");
    writeFileSync(out, 'id: "old"\n');

    const result = await llmRun(
      [corpusAt("forced.md"), "--out", out, "--force"],
      replayOf(fixtureOf("ok.json")),
    );

    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('id: "forced"');
  });
});

describe("style extract · 路径错误不花钱", () => {
  it("should refuse a missing parent and an escaping path before calling the model", async () => {
    const missingParent = fetchCallsOf();
    const outside = fetchCallsOf();

    const noParent = await llmRun(
      [corpusAt("no-parent.md"), "--out", join(dir, "nope/x.yaml")],
      missingParent.fetch,
    );
    const escaped = await llmRun(
      [corpusAt("escape.md"), "--out", "../escape.yaml", "--json"],
      outside.fetch,
    );

    expect(noParent.code).toBe(1);
    expect(noParent.err).toContain("父目录不存在");
    expect(missingParent.calls()).toBe(0);
    expect(escaped.code).toBe(3);
    expect(escaped.out).toContain('"code":"path_outside_workspace"');
    expect(outside.calls()).toBe(0);
  });
});
