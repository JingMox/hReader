// 这层管：`hr style extract` 的请求构造与"确定性失败不花钱"（--model/--base-url 落到请求、前置校验在模型调用之前）。
// 与 `style-extract-llm.test.ts` 分开只为守住单文件 300 行；网络一律假 fetch 回放 `fixtures/llm/`。

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run, type CliIo } from "../src/run";
import { fetchBodyOf, fetchUrlOf } from "./harness";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-llm-req-")));
const FIXTURES = join(import.meta.dirname, "../../../fixtures/llm");
const KEY = "sk-test-LEAKCANARY";

mkdirSync(join(dir, "styles"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fixtureOf = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const corpusAt = (name: string): string => {
  const path = join(dir, name);
  writeFileSync(
    path,
    "第一段只有一句。\n\n第二段两句。还带一个转折。\n\n第三段三句。这是第二句。这是第三句。\n",
  );
  return path;
};

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

const replayOf =
  (body: string): typeof globalThis.fetch =>
  () =>
    Promise.resolve(new Response(body));

const llmRun = async (files: readonly string[], fetch: typeof globalThis.fetch): Promise<Run> => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    cwd: dir,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(new Uint8Array()),
    debug: false,
    env: { OPENCODE_API_KEY: KEY },
    fetch,
  };
  const code = await run(["style", "extract", ...files], io);
  return { code, out: out.join(""), err: err.join("") };
};

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
